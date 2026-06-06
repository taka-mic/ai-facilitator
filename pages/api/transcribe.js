// pages/api/transcribe.js — Groq Whisper transcription (iOS fallback)
// Receives base64 audio chunks from MediaRecorder, returns Japanese text.

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { audioBase64, mimeType } = req.body;
  if (!audioBase64) return res.status(400).json({ error: 'missing audio' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  try {
    const buffer = Buffer.from(audioBase64, 'base64');

    // Determine file extension Groq accepts
    const ext = mimeType?.includes('mp4') ? 'm4a'
              : mimeType?.includes('webm') ? 'webm'
              : mimeType?.includes('ogg')  ? 'ogg'
              : 'wav';

    const formData = new FormData();
    formData.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `audio.${ext}`);
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'ja');
    formData.append('response_format', 'json');

    const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: formData,
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      console.error('[transcribe] Groq error:', err);
      return res.status(502).json({ error: err });
    }

    const data = await groqRes.json();
    res.status(200).json({ text: data.text || '' });
  } catch (e) {
    console.error('[transcribe]', e);
    res.status(500).json({ error: e.message });
  }
}
