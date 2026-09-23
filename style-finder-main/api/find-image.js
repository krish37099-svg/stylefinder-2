import { google } from 'googleapis';

function escapeQuery(s) {
  return s.replace(/'/g, "\\'");
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// True only if `code` appears in `filename` as a whole token — not as a
// substring of a longer code. "BLPOPB60" must NOT match "BLPOPB605.png",
// but must match "BLPOPB60 (1).png" or "BLPOPB60.png".
function isExactCodeMatch(filename, code) {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(code)}([^A-Za-z0-9]|$)`, 'i');
  return re.test(filename);
}

async function driveClient() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return google.drive({ version: 'v3', auth });
}

async function searchByName(drive, term) {
  // Drive's "contains" query is a substring match, so it over-returns
  // (e.g. "BLPOPB60" also brings back "BLPOPB605"). Ask for more results
  // than we need, then filter down to exact-token matches ourselves.
  const q = `name contains '${escapeQuery(term)}' and trashed = false and mimeType contains 'image/'`;
  const r = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 50 });
  const all = r.data.files || [];
  return all.filter((f) => isExactCodeMatch(f.name, term));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { styleCode } = req.body || {};
    if (!styleCode) {
      return res.status(400).json({ error: 'No style code provided' });
    }

    const drive = await driveClient();
    const files = await searchByName(drive, styleCode);

    if (files.length === 0) {
      return res.status(200).json({ matches: [], note: 'No image found matching that exact style code.' });
    }

    return res.status(200).json({ matches: files.slice(0, 3), note: '' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
