// lib/speech.js — STT/TTS wrapper
// - Chrome/Android: Web Speech API (free, real-time)
// - iOS/unsupported: MediaRecorder → Groq Whisper API (10s chunks)
//
// onChunk signature: ({ text, isFinal, speaker, error? }) => void
// error field is set when something goes wrong (shown to user)

// ─── STT backend detection ────────────────────────────────────────────────────

export function isSTTSupported() {
  if (typeof window === 'undefined') return false;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition) ||
    !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

// iOS Chrome cannot use Web Speech API and getUserMedia is unreliable.
// iOS Safari 15+ supports webkitSpeechRecognition natively.
export function isIOSChrome() {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) && /CriOS/.test(ua);
}

function useWebSpeech() {
  return typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// ─── Web Speech API (Chrome / Android) ───────────────────────────────────────

let recognition = null;
let activeCallback = null;

function startWebSpeech(onChunk) {
  activeCallback = onChunk;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (activeCallback) activeCallback({ text: r[0].transcript, isFinal: r.isFinal, speaker: null });
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech') return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      if (activeCallback) activeCallback({ text: '', isFinal: false, speaker: null, error: 'マイクへのアクセスが拒否されました。ブラウザのアドレスバー横の 🔒 アイコンからマイクを許可してください。' });
      activeCallback = null;
      return;
    }
    if (e.error === 'audio-capture') {
      if (activeCallback) activeCallback({ text: '', isFinal: false, speaker: null, error: 'マイクが見つかりません。マイクが接続されているか確認してください。' });
      return;
    }
    if (e.error === 'network') {
      setTimeout(() => { if (activeCallback) recognition.start(); }, 1000);
      return;
    }
    console.warn('STT error:', e.error);
  };

  recognition.onend = () => {
    if (activeCallback) setTimeout(() => { if (activeCallback) recognition.start(); }, 300);
  };

  recognition.start();
}

function stopWebSpeech() {
  activeCallback = null;
  if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
}

// ─── MediaRecorder → Groq Whisper (iOS / fallback) ───────────────────────────

let mediaStream = null;
let mediaRecorder = null;
let chunkTimer = null;
let mediaCallback = null;
let isMediaActive = false;

const CHUNK_INTERVAL_MS = 10000; // 10s per chunk

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function startMediaSTT(onChunk) {
  mediaCallback = onChunk;
  isMediaActive = true;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    isMediaActive = false;
    // Show exact error name to help diagnose permission issues
    const msg = `マイクエラー [${e.name}]: ${e.message}`;
    throw new Error(msg);
  }

  // Show "recording started" feedback
  onChunk({ text: '', isFinal: false, speaker: null, info: '🎙 録音開始（10秒ごとに文字起こしします）' });

  startChunk();
  chunkTimer = setInterval(() => {
    if (!isMediaActive) return;
    if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  }, CHUNK_INTERVAL_MS);
}

function startChunk() {
  if (!isMediaActive || !mediaStream) return;
  const mimeType = getSupportedMimeType();
  const chunks = [];

  try {
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
  } catch (_) {
    mediaRecorder = new MediaRecorder(mediaStream);
  }

  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    if (chunks.length === 0 || !isMediaActive) return;
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    if (blob.size < 500) { if (isMediaActive) startChunk(); return; }
    await transcribeBlob(blob, mediaRecorder.mimeType);
    if (isMediaActive) startChunk();
  };

  mediaRecorder.start();
}

async function transcribeBlob(blob, mimeType) {
  // Show interim "processing" indicator
  if (mediaCallback) mediaCallback({ text: '（音声を処理中...）', isFinal: false, speaker: null });

  try {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    const res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64, mimeType }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (mediaCallback) mediaCallback({ text: '', isFinal: false, speaker: null, error: `文字起こし失敗 (${res.status}): ${errText}` });
      return;
    }

    const { text, error } = await res.json();
    if (error) {
      if (mediaCallback) mediaCallback({ text: '', isFinal: false, speaker: null, error: `Groq エラー: ${error}` });
      return;
    }
    if (text?.trim() && mediaCallback) {
      mediaCallback({ text: text.trim(), isFinal: true, speaker: null });
    } else if (mediaCallback) {
      // Clear the "processing" interim
      mediaCallback({ text: '', isFinal: false, speaker: null });
    }
  } catch (e) {
    if (mediaCallback) mediaCallback({ text: '', isFinal: false, speaker: null, error: `通信エラー: ${e.message}` });
  }
}

function stopMediaSTT() {
  isMediaActive = false;
  mediaCallback = null;
  clearInterval(chunkTimer); chunkTimer = null;
  if (mediaRecorder?.state === 'recording') { try { mediaRecorder.stop(); } catch (_) {} }
  mediaRecorder = null;
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// ─── Deepgram WebSocket STT ───────────────────────────────────────────────────

let dgSocket = null;
let dgStream = null;
let dgCallback = null;
let dgProcessor = null;
let dgAudioCtx = null;

export async function startDeepgramSTT(onChunk) {
  dgCallback = onChunk;

  // 1. Fetch short-lived token from our server-side proxy
  const tokenRes = await fetch('/api/deepgram-token', { method: 'POST' });
  if (!tokenRes.ok) throw new Error(`トークン取得失敗: ${await tokenRes.text()}`);
  const { token, error: tokenErr } = await tokenRes.json();
  if (tokenErr) throw new Error(tokenErr);

  // 2. Get microphone stream
  try {
    dgStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new Error(`マイクエラー [${e.name}]: ${e.message}`);
  }

  // 3. Open Deepgram WebSocket
  const params = new URLSearchParams({
    language: 'ja',
    model: 'nova-2',
    punctuate: 'true',
    diarize: 'true',
    interim_results: 'true',
    endpointing: '500',
    encoding: 'linear16',
    sample_rate: '16000',
  });
  dgSocket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', token]);

  dgSocket.onopen = () => {
    onChunk({ text: '', isFinal: false, speaker: null, info: '🎙 Deepgram 接続完了（話者分離あり）' });
    startAudioPump();
  };

  dgSocket.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type !== 'Results') return;

    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;

    const text = alt.transcript || '';
    const isFinal = msg.is_final;

    // Extract dominant speaker from word-level data
    let speaker = null;
    if (alt.words?.length > 0) {
      const counts = {};
      for (const w of alt.words) {
        if (w.speaker != null) counts[w.speaker] = (counts[w.speaker] || 0) + 1;
      }
      speaker = `speaker_${Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]}`;
    }

    if (dgCallback) dgCallback({ text, isFinal, speaker });
  };

  dgSocket.onerror = () => {
    if (dgCallback) dgCallback({ text: '', isFinal: false, speaker: null, error: 'Deepgram 接続エラー' });
  };

  dgSocket.onclose = (evt) => {
    if (evt.code !== 1000 && dgCallback) {
      dgCallback({ text: '', isFinal: false, speaker: null, error: `Deepgram 切断 (${evt.code})` });
    }
  };
}

function startAudioPump() {
  if (!dgStream) return;
  dgAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = dgAudioCtx.createMediaStreamSource(dgStream);
  // ScriptProcessor for broad browser compatibility (deprecated but works everywhere)
  dgProcessor = dgAudioCtx.createScriptProcessor(4096, 1, 1);
  dgProcessor.onaudioprocess = (e) => {
    if (dgSocket?.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }
    dgSocket.send(int16.buffer);
  };
  source.connect(dgProcessor);
  dgProcessor.connect(dgAudioCtx.destination);
}

export function stopDeepgramSTT() {
  dgCallback = null;
  if (dgProcessor) { try { dgProcessor.disconnect(); } catch (_) {} dgProcessor = null; }
  if (dgAudioCtx) { try { dgAudioCtx.close(); } catch (_) {} dgAudioCtx = null; }
  if (dgSocket) { try { dgSocket.close(1000); } catch (_) {} dgSocket = null; }
  if (dgStream) { dgStream.getTracks().forEach(t => t.stop()); dgStream = null; }
}

// ─── Public STT API ───────────────────────────────────────────────────────────

let deepgramMode = false;

export async function startSTT(onChunk, { useDeepgram = false } = {}) {
  deepgramMode = useDeepgram;
  if (useDeepgram) await startDeepgramSTT(onChunk);
  else if (useWebSpeech()) startWebSpeech(onChunk);
  else await startMediaSTT(onChunk);
}

export function stopSTT() {
  if (deepgramMode) stopDeepgramSTT();
  else if (useWebSpeech()) stopWebSpeech();
  else stopMediaSTT();
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

function getVoicesAsync() {
  return new Promise(resolve => {
    const v = window.speechSynthesis.getVoices();
    if (v.length > 0) return resolve(v);
    window.speechSynthesis.onvoiceschanged = () => resolve(window.speechSynthesis.getVoices());
  });
}

let cachedVoice = null;
let preferredVoiceName = null;

export function setPreferredVoice(name) {
  preferredVoiceName = name;
  cachedVoice = null; // reset cache
}

export async function getJapaneseVoices() {
  if (typeof window === 'undefined') return [];
  const voices = await getVoicesAsync();
  return voices.filter(v => v.lang.startsWith('ja'));
}

async function pickJapaneseVoice() {
  const voices = await getVoicesAsync();
  const ja = voices.filter(v => v.lang.startsWith('ja'));
  if (preferredVoiceName) {
    const match = ja.find(v => v.name === preferredVoiceName);
    if (match) { cachedVoice = match; return cachedVoice; }
  }
  if (cachedVoice) return cachedVoice;
  cachedVoice = ja.find(v => /google/i.test(v.name)) || ja.find(v => !v.localService) || ja[0] || null;
  return cachedVoice;
}

export async function speak(text, onEnd) {
  cancelSpeak();
  const voice = await pickJapaneseVoice();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  if (voice) utter.voice = voice;
  utter.rate = 0.95; utter.pitch = 1.0; utter.volume = 1.0;
  utter.onend = () => { if (onEnd) onEnd(); };
  utter.onerror = () => { if (onEnd) onEnd(); };
  window.speechSynthesis.speak(utter);
}

export function cancelSpeak() { window.speechSynthesis.cancel(); }

// ─── Chime ────────────────────────────────────────────────────────────────────

export function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[880, 0, 0.15], [1108, 0.18, 0.12]].forEach(([freq, start, dur]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur);
    });
  } catch (_) {}
}
