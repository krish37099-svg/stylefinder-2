import { google } from 'googleapis';
import { kv } from '@vercel/kv';

const MAX_UNKNOWN_PER_CALL = 24; // how many not-yet-seen style codes to process in one request
const CONCURRENCY = 5;           // parallel Gemini calls at a time

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
  const r = await drive.files.list({ q, fields: 'files(id, name, mimeType)', pageSize: 5 });
  return r.data.files || [];
}

async function findDriveImage(drive, styleCode) {
  let files = await searchByName(drive, styleCode);
  if (files.length === 0) {
    const prefix = styleCode.split('-')[0].trim();
    if (prefix && prefix !== styleCode) {
      files = await searchByName(drive, prefix);
    }
  }
  return files[0] || null;
}

async function fetchImageBase64(drive, fileId) {
  const result = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(result.data).toString('base64');
}

// Only style codes starting "BLP" use a pasted sticker. Plain "BL..." (no P) are readymade prints — no sticker to scan.
function needsStickerScan(styleCode) {
  return /^BLP/i.test((styleCode || '').trim());
}

function normalizeKey(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Small edit-distance check so trivial OCR wobble between separate scans (an extra space, a
// dropped punctuation mark) doesn't fragment what is really the same printed sticker text.
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function findCloseCanonKey(key, canonKeys) {
  if (!key) return null;
  if (canonKeys.includes(key)) return key;
  const threshold = key.length <= 6 ? 1 : Math.max(2, Math.round(key.length * 0.12));
  let best = null, bestDist = Infinity;
  for (const ck of canonKeys) {
    if (Math.abs(ck.length - key.length) > threshold) continue;
    const d = levenshtein(key, ck);
    if (d <= threshold && d < bestDist) { best = ck; bestDist = d; }
  }
  return best;
}

async function clearStickerCache() {
  try {
    const keys = await kv.keys('stickermap:*');
    for (let i = 0; i < keys.length; i += 200) {
      await Promise.all(keys.slice(i, i + 200).map(k => kv.del(k)));
    }
  } catch (e) { /* best effort */ }
  await kv.set('stickers:catalog', {});
}

const EXTRACT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    stickerText: { type: 'STRING' },
    stickerMotif: { type: 'STRING' },
    hasSticker: { type: 'BOOLEAN' }
  },
  required: ['stickerText', 'stickerMotif', 'hasSticker']
};

async function extractSticker(base64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        {
          text:
`This is a product photo of a kids' garment with a printed/pasted graphic "sticker" on it. Look ONLY at the printed design — completely ignore the garment's fabric color, garment type, background, and any "100% cotton" logo badge.

- "stickerText": transcribe any text that is part of the printed design, EXACTLY as printed, including any spelling mistakes, letter-for-letter (e.g. if it says "Independencee" with a double e, write it that way). Empty string if the design has no text.
- "stickerMotif": if there is a graphic/illustration element (a character, animal, icon), describe it in 3-6 words (e.g. "penguin holding red scarf"). Empty string if the design is text-only with no illustration.
- "hasSticker": true if there is any printed design at all on the garment.`
        },
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: EXTRACT_SCHEMA
    }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await apiRes.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        if (typeof parsed.stickerText === 'string' || typeof parsed.stickerMotif === 'string') return parsed;
      }
    } catch (e) {
      // retry once
    }
  }
  return null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, resetCache } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No order items provided' });
    }

    if (resetCache) {
      await clearStickerCache();
    }

    const scanItems = items.filter(o => needsStickerScan(o.styleCode));
    const skipped = items
      .filter(o => !needsStickerScan(o.styleCode))
      .map(o => ({ styleCode: o.styleCode, reason: 'readymade' }));

    if (scanItems.length === 0) {
      return res.status(200).json({ groups: [], skipped, noImage: [], remainingUnknown: 0, note: 'No sticker-based styles ("BLP…") found in this sheet.' });
    }

    const uniqueCodes = [...new Set(scanItems.map(o => (o.styleCode || '').trim()).filter(Boolean))];

    // catalog: { canonKey: { label, driveFileId, mimeType } }
    let catalog = (await kv.get('stickers:catalog')) || {};

    const knownMap = {}; // styleCode -> canonKey
    const kvLookups = await Promise.all(uniqueCodes.map(code => kv.get(`stickermap:${code}`)));
    const unknownCodes = [];
    uniqueCodes.forEach((code, i) => {
      if (kvLookups[i]) knownMap[code] = kvLookups[i];
      else unknownCodes.push(code);
    });

    const noImage = [];
    let remainingUnknown = 0;
    let scanWarning = null;

    if (unknownCodes.length > 0) {
      const drive = await driveClient();
      const toProcess = unknownCodes.slice(0, MAX_UNKNOWN_PER_CALL);
      const overflow = unknownCodes.slice(MAX_UNKNOWN_PER_CALL);
      remainingUnknown = overflow.length;

      let extractionFailures = 0;

      // Process each unknown style code independently — fetch its image, then extract its sticker.
      const perCodeResults = await mapWithConcurrency(toProcess, CONCURRENCY, async (code) => {
        const file = await findDriveImage(drive, code);
        if (!file) return { code, noImage: true };
        let base64;
        try {
          base64 = await fetchImageBase64(drive, file.id);
        } catch (e) {
          return { code, noImage: true };
        }
        const extracted = await extractSticker(base64, file.mimeType);
        if (!extracted) {
          extractionFailures++;
          return { code, fileId: file.id, mimeType: file.mimeType, extracted: null };
        }
        return { code, fileId: file.id, mimeType: file.mimeType, extracted };
      });

      // Assign each to a canon sticker key, in a fixed order so matches within this same
      // batch are resolved deterministically (first occurrence defines the label).
      const canonKeys = Object.keys(catalog);
      for (const r of perCodeResults) {
        if (r.noImage) { noImage.push(r.code); continue; }
        if (!r.extracted) {
          // extraction failed twice — fall back to a solo group keyed on the style code itself
          const key = `code:${r.code.toLowerCase()}`;
          catalog[key] = catalog[key] || { label: r.code, driveFileId: r.fileId, mimeType: r.mimeType };
          knownMap[r.code] = key;
          continue;
        }
        const rawLabel = (r.extracted.stickerText || '').trim() || (r.extracted.stickerMotif || '').trim();
        const normKey = normalizeKey(rawLabel) || `code ${r.code.toLowerCase()}`;
        let key = findCloseCanonKey(normKey, canonKeys);
        if (!key) {
          key = normKey;
          catalog[key] = { label: rawLabel || r.code, driveFileId: r.fileId, mimeType: r.mimeType };
          canonKeys.push(key);
        } else if (!catalog[key]) {
          catalog[key] = { label: rawLabel || r.code, driveFileId: r.fileId, mimeType: r.mimeType };
        }
        knownMap[r.code] = key;
      }

      if (extractionFailures > 0) {
        scanWarning = `${extractionFailures} style code(s) couldn't be read by the sticker-recognition AI and were filed under their own style code — try scanning again.`;
      }

      await kv.set('stickers:catalog', catalog);
      await Promise.all(
        toProcess
          .filter(code => knownMap[code])
          .map(code => kv.set(`stickermap:${code}`, knownMap[code]))
      );
    }

    // Build the response groups from the full order list using whatever mappings we now have
    const groupsByKey = {};
    const stillNoImage = [];
    for (const o of scanItems) {
      const code = (o.styleCode || '').trim();
      const key = knownMap[code];
      if (!key) {
        if (!noImage.includes(code)) stillNoImage.push(code);
        continue;
      }
      if (!groupsByKey[key]) {
        const meta = catalog[key] || { label: code, driveFileId: null };
        groupsByKey[key] = { key, label: meta.label, driveFileId: meta.driveFileId, orderCount: 0, totalQty: 0, orders: [] };
      }
      groupsByKey[key].orderCount += 1;
      groupsByKey[key].totalQty += Number(o.qty) || 0;
      groupsByKey[key].orders.push({ styleCode: code, age: o.age, qty: o.qty });
    }

    const groups = Object.values(groupsByKey).sort((a, b) => b.totalQty - a.totalQty);

    return res.status(200).json({
      groups,
      skipped,
      noImage: [...new Set([...noImage, ...stillNoImage])],
      remainingUnknown,
      scanWarning
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
