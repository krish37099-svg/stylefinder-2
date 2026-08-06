import { google } from 'googleapis';

function escapeQuery(s) {
  return s.replace(/'/g, "\\'");
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
  const q = `name contains '${escapeQuery(term)}' and trashed = false and mimeType contains 'image/'`;
  const r = await drive.files.list({ q, fields: 'files(id, name)', pageSize: 10 });
  return r.data.files || [];
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

    let files = await searchByName(drive, styleCode);
    let note = '';

    if (files.length === 0) {
      const prefix = styleCode.split('-')[0].trim();
      if (prefix && prefix !== styleCode) {
        files = await searchByName(drive, prefix);
        if (files.length > 0) {
          note = `Matched by "${prefix}" — the exact code "${styleCode}" wasn't in a filename.`;
        }
      }
    }

    if (files.length === 0) {
      return res.status(200).json({ matches: [], note: 'No image found matching that style code.' });
    }

    return res.status(200).json({ matches: files.slice(0, 3), note });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
