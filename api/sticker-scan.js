import { google } from 'googleapis';
import { kv } from '@vercel/kv';

const MAX_UNKNOWN_PER_CALL = 20;   // cap images sent to Gemini in one request
const MAX_EXISTING_GROUPS_SHOWN = 20; // cap existing sticker groups shown for comparison

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

function slugify(label) {
  return (label || 'sticker').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'sticker';
}

// Only style codes starting "BLP" use a pasted sticker. Plain "BL..." (no P) are readymade prints — no sticker to scan.
function needsStickerScan(styleCode) {
  return /^BLP/i.test((styleCode || '').trim());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No order items provided' });
    }

    const scanItems = items.filter(o => needsStickerScan(o.styleCode));
    const skipped = items
      .filter(o => !needsStickerScan(o.styleCode))
      .map(o => ({ styleCode: o.styleCode, reason: 'readymade' }));

    if (scanItems.length === 0) {
      return res.status(200).json({ groups: [], skipped, noImage: [], remainingUnknown: 0, note: 'No sticker-based styles ("BLP…") found in this sheet.' });
    }

    const uniqueCodes = [...new Set(scanItems.map(o => (o.styleCode || '').trim()).filter(Boolean))];

    // 1. Check which style codes already have a known sticker mapping (built up over past scans)
    const knownMap = {};
    const kvLookups = await Promise.all(uniqueCodes.map(code => kv.get(`stickermap:${code}`)));
    const unknownCodes = [];
    uniqueCodes.forEach((code, i) => {
      if (kvLookups[i]) knownMap[code] = kvLookups[i];
      else unknownCodes.push(code);
    });

    const noImage = [];
    let stickerIndex = (await kv.get('stickers:index')) || [];
    let remainingUnknown = 0;

    if (unknownCodes.length > 0) {
      const drive = await driveClient();
      const toProcess = unknownCodes.slice(0, MAX_UNKNOWN_PER_CALL);
      const overflow = unknownCodes.slice(MAX_UNKNOWN_PER_CALL);

      // 2. Fetch drive images for the unknown style codes
      const unknownImages = [];
      for (const code of toProcess) {
        const file = await findDriveImage(drive, code);
        if (!file) { noImage.push(code); continue; }
        try {
          const base64 = await fetchImageBase64(drive, file.id);
          unknownImages.push({ styleCode: code, fileId: file.id, mimeType: file.mimeType || 'image/jpeg', base64 });
        } catch (e) {
          noImage.push(code);
        }
      }

      if (unknownImages.length > 0) {
        // 3. Pull representative images for existing sticker groups, so the model can match against them
        const existingGroups = stickerIndex.slice(0, MAX_EXISTING_GROUPS_SHOWN);
        const groupRefImages = [];
        for (const g of existingGroups) {
          if (!g.driveFileId) continue;
          try {
            const base64 = await fetchImageBase64(drive, g.driveFileId);
            groupRefImages.push({ key: g.key, base64, mimeType: g.mimeType || 'image/jpeg' });
          } catch (e) {
            // stale/broken reference — skip, model just won't have an image for that group
          }
        }

        const apiKey = process.env.GEMINI_API_KEY;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const parts = [];
        parts.push({
          text:
`You are looking at product photos of kids' clothing. Each garment has a printed/pasted graphic "sticker" design on it (a character, motif, or text print). The SAME sticker design gets reused across many different style codes and different garment fabric colors — ignore fabric color and garment type, and compare ONLY the printed graphic/text design.

For each item labeled NEW_ITEM below, decide:
- If its sticker design matches one of the EXISTING_GROUP images shown, set "groupIndex" to that group's index number and "newLabel" to null.
- If it does NOT match any EXISTING_GROUP, set "groupIndex" to null and give it a short "newLabel" (3-5 words describing the print, e.g. "Elephant on pastel", "Happy Independence Day baby romper", "Dad Is My Hero text tee"). If two or more NEW_ITEMs in this batch clearly share the same sticker design as each other, give them the EXACT same "newLabel" string (identical characters) so they group together.

Respond ONLY with JSON: {"assignments": [{"styleCode": "...", "groupIndex": <number or null>, "newLabel": <string or null>}]}`
        });

        existingGroups.forEach((g, i) => {
          const ref = groupRefImages.find(r => r.key === g.key);
          parts.push({ text: `EXISTING_GROUP index=${i} label="${g.label}"` });
          if (ref) parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.base64 } });
        });

        unknownImages.forEach(item => {
          parts.push({ text: `NEW_ITEM styleCode="${item.styleCode}"` });
          parts.push({ inline_data: { mime_type: item.mimeType, data: item.base64 } });
        });

        const body = {
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json' }
        };

        let parsed = { assignments: [] };
        try {
          const apiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const data = await apiRes.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) parsed = JSON.parse(text);
        } catch (e) {
          // fall through — unmatched items handled below become their own groups
        }

        const newLabelToKey = {};
        for (const a of (parsed.assignments || [])) {
          const item = unknownImages.find(u => u.styleCode === a.styleCode);
          if (!item) continue;
          let stickerKey;
          if (a.groupIndex !== null && a.groupIndex !== undefined && existingGroups[a.groupIndex]) {
            stickerKey = existingGroups[a.groupIndex].key;
          } else if (a.newLabel) {
            if (!newLabelToKey[a.newLabel]) {
              const key = `${slugify(a.newLabel)}-${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 5)}`;
              newLabelToKey[a.newLabel] = key;
              stickerIndex.unshift({ key, label: a.newLabel, driveFileId: item.fileId, mimeType: item.mimeType });
            }
            stickerKey = newLabelToKey[a.newLabel];
          }
          if (stickerKey) knownMap[item.styleCode] = stickerKey;
        }

        // Anything the model didn't return an assignment for becomes its own single-code group
        for (const item of unknownImages) {
          if (!knownMap[item.styleCode]) {
            const key = `unmatched-${item.styleCode.toLowerCase()}`;
            stickerIndex.unshift({ key, label: item.styleCode, driveFileId: item.fileId, mimeType: item.mimeType });
            knownMap[item.styleCode] = key;
          }
        }

        // Persist the sticker directory + per-style-code mapping so future scans are instant
        stickerIndex = stickerIndex.slice(0, 300);
        await kv.set('stickers:index', stickerIndex);
        await Promise.all(
          toProcess
            .filter(code => knownMap[code])
            .map(code => kv.set(`stickermap:${code}`, knownMap[code]))
        );
      }

      // Codes not attempted this round (beyond the per-call cap) — client will call again
      remainingUnknown = overflow.length;
    }

    // 4. Build the response groups from the full order list using whatever mappings we now have
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
        const meta = stickerIndex.find(g => g.key === key) || { key, label: code, driveFileId: null };
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
      remainingUnknown
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
