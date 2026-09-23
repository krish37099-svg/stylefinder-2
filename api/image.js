import { google } from 'googleapis';

export default async function handler(req, res) {
  try {
    const { id } = req.query;
    if (!id) {
      return res.status(400).send('Missing id');
    }

    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    const drive = google.drive({ version: 'v3', auth });

    const result = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Type', result.headers['content-type'] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    result.data.pipe(res);
  } catch (err) {
    res.status(500).send('Could not load image: ' + err.message);
  }
}
 
