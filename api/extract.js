export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const body = {
      contents: [{
        parts: [
          {
            text: "Extract the Style Code from this invoice photo. The invoice has a line labeled 'Style Code:' followed by a code, often like \"BLPTSW443-67\" (may or may not have quote marks around it in the image)."
          },
          {
            inline_data: {
              mime_type: mediaType || 'image/jpeg',
              data: imageBase64
            }
          }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            styleCode: { type: "STRING" },
            found: { type: "BOOLEAN" }
          },
          required: ["styleCode", "found"]
        }
      }
    };

    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await apiRes.json();
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({ error: data });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: 'No response from Gemini', raw: data });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: 'Could not parse model response', raw: text });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
