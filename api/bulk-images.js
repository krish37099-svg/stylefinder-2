import { google } from 'googleapis';

function escapeQuery(s) {
  return s.replace(/'/g, "\\'");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True only if `code` appears in `filename` as a whole token — not as a
// substring of a longer code.
function isExactCodeMatch(filename, code) {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(code)}([^A-Za-z0-9]|$)`, 'i');
  return re.test(filename);
}

// "BLPNANW322B (1).jpg" sorts before "(2)", "(10)" sorts after "(2)", etc.
function sortByTrailingNumber(files) {
  return files.slice().sort((a, b) => {
    const na = a.name.match(/\((\d+)\)/);
    const nb = b.name.match(/\((\d+)\)/);
    if (na && nb) return parseInt(na[1], 10) - parseInt(nb[1], 10);
    return a.name.localeCompare(b.name);
  });
}

async function driveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return google.drive({ version: 'v3', auth });
}

// Step 1: look for a folder whose name is exactly the style code.
async function findFolder(drive, styleCode) {
  const q = `name = '${escapeQuery(styleCode)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return (r.data.files || [])[0] || null;
}

// Step 2: every image sitting directly inside that folder.
async function listImagesInFolder(drive, folderId) {
  const q = `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  return sortByTrailingNumber(r.data.files || []);
}

// Fallback: no folder — some style codes are a single direct image file.
async function findDirectImages(drive, styleCode) {
  const q = `name contains '${escapeQuery(styleCode)}' and mimeType contains 'image/' and trashed = false`;
  const r = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });
  const exact = (r.data.files || []).filter((f) => isExactCodeMatch(f.name, styleCode));
  return sortByTrailingNumber(exact);
}

async function resolveStyleCode(drive, styleCode) {
  const folder = await findFolder(drive, styleCode);
  let files = folder ? await listImagesInFolder(drive, folder.id) : [];
  if (files.length === 0) {
    files = await findDirectImages(drive, styleCode);
  }
  if (files.length === 0) {
    // Nothing on Drive for this code — leave it empty rather than guessing,
    // and say why so the caller can warn about it instead of failing silently.
    return {
      images: [],
      note: folder
        ? 'A folder named ' + styleCode + ' exists but has no images in it.'
        : 'No folder or direct image named ' + styleCode + ' was found on Drive.'
    };
  }
  return { images: files.map((f) => ({ id: f.id, name: f.name })), note: '' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { styleCodes } = req.body || {};
    if (!Array.isArray(styleCodes) || styleCodes.length === 0) {
      return res.status(400).json({ error: 'styleCodes (non-empty array) is required' });
    }

    // Dedupe here too, so a sloppy client never pays for the same Drive
    // lookup twice — this is the "don't recompute per age group" rule.
    const unique = [...new Set(styleCodes.map((s) => String(s).trim()).filter(Boolean))];
    const drive = await driveClient();

    const results = {};
    const CONCURRENCY = 5;
    let cursor = 0;
    async function worker() {
      while (cursor < unique.length) {
        const code = unique[cursor++];
        try {
          results[code] = await resolveStyleCode(drive, code);
        } catch (e) {
          results[code] = { images: [], error: e.message };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
