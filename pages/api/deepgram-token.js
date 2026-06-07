// pages/api/deepgram-token.js
// Issues a short-lived Deepgram temporary API token for browser WebSocket use.
// DEEPGRAM_API_KEY stays server-side only.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not set' });

  try {
    // Create a temporary key valid for 60 seconds, scoped to usage only
    const resp = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ time_to_live_in_seconds: 60 }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[deepgram-token]', err);
      return res.status(502).json({ error: err });
    }

    const data = await resp.json();
    res.status(200).json({ token: data.key });
  } catch (e) {
    console.error('[deepgram-token]', e);
    res.status(500).json({ error: e.message });
  }
}
