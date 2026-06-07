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

// ─── Public STT API ───────────────────────────────────────────────────────────

export async function startSTT(onChunk) {
  if (useWebSpeech()) startWebSpeech(onChunk);
  else await startMediaSTT(onChunk);
}

export function stopSTT() {
  if (useWebSpeech()) stopWebSpeech();
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

async function pickJapaneseVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = await getVoicesAsync();
  const ja = voices.filter(v => v.lang.startsWith('ja'));
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
