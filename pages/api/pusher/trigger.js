// pages/api/pusher/trigger.js
// Host POSTs sync events here; this broadcasts to all viewers on the same session channel.

import Pusher from 'pusher';

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { sessionId, event, data } = req.body;
  if (!sessionId || !event) return res.status(400).json({ error: 'missing sessionId or event' });

  await pusher.trigger(`session-${sessionId}`, event, data);
  res.status(200).json({ ok: true });
}
