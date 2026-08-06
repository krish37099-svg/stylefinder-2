import { google } from 'googleapis';
import { kv } from '@vercel/kv';

const MAX_UNKNOWN_PER_CALL = 16;   // cap images sent to Gemini in one request
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

async function clearStickerCache() {
  try {
    const keys = await kv.keys('stickermap:*');
    if (keys.length > 0) {
      for (let i = 0; i < keys.length; i += 200) {
        await Promise.all(keys.slice(i, i + 200).map(k => kv.del(k)));
      }
    }
  } catch (e) { /* best effort */ }
  await kv.set('stickers:index', []);
}

const GROUPING_SCHEMA = {
  type: 'OBJECT',
  properties: {
    matchedToExisting: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          groupIndex: { type: 'INTEGER' },
          styleCodes: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['groupIndex', 'styleCodes']
      }
    },
    newGroups: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          styleCodes: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['label', 'styleCodes']
      }
    }
  },
  required: ['matchedToExisting', 'newGroups']
};

async function callGeminiGrouping(parts) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GROUPING_SCHEMA
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
        if (Array.isArray(parsed.matchedToExisting) || Array.isArray(parsed.newGroups)) return parsed;
      }
    } catch (e) {
      // retry once
    }
  }
  return null; // caller handles the fallback
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
    let scanWarning = null;

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

        const parts = [];
        parts.push({
          text:
`You are comparing product photos of kids' clothing. Each garment has a printed/pasted graphic "sticker" — a character illustration, motif, or text design — applied to it. The exact same sticker artwork is reused across many different style codes and garment colors/types (t-shirt, onesie, romper, all colors) — garment color and garment type are NEVER relevant, ignore them completely.

Group items together ONLY if the sticker artwork itself is identical or a straightforward palette recolor of the same artwork: same wording (character-for-character, including any typos), same illustration, same layout/composition. Two designs that are merely similar in theme (e.g. both "Independence Day" themed, both featuring an elephant, both a birthday design) but have DIFFERENT wording or a different illustration are DIFFERENT stickers and must NOT be grouped — e.g. a print reading "My First Independence Day" is a different sticker from one reading "Happy Independence Day", even though both are patriotic prints.

You are given:
- EXISTING_GROUP entries: stickers already catalogued, each with an index number, a label, and (usually) a reference photo.
- NEW_ITEM entries: newly scanned style codes that need to be placed into a sticker group.

For every NEW_ITEM style code, decide exactly one of:
(a) it matches an EXISTING_GROUP's artwork — list its styleCode under that group's index in "matchedToExisting"
(b) it matches one or more OTHER NEW_ITEMs' artwork but no existing group — list all of those styleCodes together under one entry in "newGroups" with a short descriptive label (3-6 words, describe the actual wording/illustration so it's recognizable, e.g. "Happy Independence Day script tee" or "My First Independence Day tricolor brush")
(c) it matches nothing else — it still goes in "newGroups" as its own single-styleCode entry with a label

Every NEW_ITEM styleCode must appear exactly once, in either matchedToExisting or newGroups.`
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

        const parsed = await callGeminiGrouping(parts);

        if (!parsed) {
          scanWarning = 'The sticker-matching AI call failed — new style codes were each filed as their own separate group this round. Try scanning again.';
        }

        const seenThisBatch = new Set();

        for (const m of (parsed?.matchedToExisting || [])) {
          const group = existingGroups[m.groupIndex];
          if (!group) continue;
          for (const code of (m.styleCodes || [])) {
            const item = unknownImages.find(u => u.styleCode === code);
            if (!item || seenThisBatch.has(code)) continue;
            knownMap[code] = group.key;
            seenThisBatch.add(code);
          }
        }

        for (const ng of (parsed?.newGroups || [])) {
          const codesInGroup = (ng.styleCodes || []).filter(code =>
            unknownImages.some(u => u.styleCode === code) && !seenThisBatch.has(code)
          );
          if (codesInGroup.length === 0) continue;
          const repItem = unknownImages.find(u => u.styleCode === codesInGroup[0]);
          const key = `${slugify(ng.label)}-${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 5)}`;
          stickerIndex.unshift({ key, label: ng.label || repItem.styleCode, driveFileId: repItem.fileId, mimeType: repItem.mimeType });
          for (const code of codesInGroup) {
            knownMap[code] = key;
            seenThisBatch.add(code);
          }
        }

        // Anything the model didn't place anywhere (including total call failure) becomes its own solo group
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
      remainingUnknown,
      scanWarning
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
