import { kv } from '@vercel/kv';

function randomId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const index = (await kv.get('sheets:index')) || [];
      return res.status(200).json({ sheets: index });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { filename, orders } = req.body || {};
      if (!filename || !Array.isArray(orders) || orders.length === 0) {
        return res.status(400).json({ error: 'filename and a non-empty orders array are required' });
      }

      const id = randomId();
      const uploadedAt = new Date().toISOString();
      const doc = { id, filename, uploadedAt, orders };
      await kv.set(`sheet:${id}`, doc);

      const totalQty = orders.reduce((sum, o) => sum + (Number(o.qty) || 0), 0);
      const summary = { id, filename, uploadedAt, orderCount: orders.length, totalQty, tickedCount: 0 };

      const index = (await kv.get('sheets:index')) || [];
      index.unshift(summary);
      await kv.set('sheets:index', index.slice(0, 100)); // keep the list from growing forever

      return res.status(200).json({ id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
