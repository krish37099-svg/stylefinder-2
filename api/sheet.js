import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const doc = await kv.get(`sheet:${id}`);
      if (!doc) return res.status(404).json({ error: 'Sheet not found' });
      return res.status(200).json(doc);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { id, index, fulfilled } = req.body || {};
      if (!id || typeof index !== 'number') {
        return res.status(400).json({ error: 'id and index are required' });
      }
      const doc = await kv.get(`sheet:${id}`);
      if (!doc) return res.status(404).json({ error: 'Sheet not found' });
      if (!doc.orders[index]) return res.status(400).json({ error: 'Invalid order index' });

      doc.orders[index].fulfilled = !!fulfilled;
      await kv.set(`sheet:${id}`, doc);

      // keep the saved-sheets list's fulfilled count roughly in sync
      const idx = (await kv.get('sheets:index')) || [];
      const entry = idx.find((s) => s.id === id);
      if (entry) {
        entry.tickedCount = doc.orders.filter((o) => o.fulfilled).length;
        await kv.set('sheets:index', idx);
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
