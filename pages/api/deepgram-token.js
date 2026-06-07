// pages/api/deepgram-token.js
// Returns the Deepgram API key for browser WebSocket use.
// The key never appears in client-side source — it's fetched at runtime via this route.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not set' });

  res.status(200).json({ token: key });
}
