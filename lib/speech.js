// lib/speech.js — STT/TTS wrapper (browser-only)
// Phase 2: replace startSTT internals with Deepgram/AssemblyAI.
// The onChunk callback interface must stay the same.

export function isSTTSupported() {
  return typeof window !== 'undefined' &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// ─── STT ──────────────────────────────────────────────────────────────────────

let recognition = null;
let activeCallback = null;

// onChunk: ({ text: string, isFinal: boolean, speaker: string|null }) => void
export function startSTT(onChunk) {
  activeCallback = onChunk;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (activeCallback) {
        activeCallback({ text: r[0].transcript, isFinal: r.isFinal, speaker: null });
      }
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech') return;
    console.warn('STT error:', e.error);
    if (['network', 'audio-capture'].includes(e.error)) {
      setTimeout(() => { if (activeCallback) recognition.start(); }, 1000);
    }
  };

  recognition.onend = () => {
    if (activeCallback) setTimeout(() => { if (activeCallback) recognition.start(); }, 300);
  };

  recognition.start();
}

export function stopSTT() {
  activeCallback = null;
  if (recognition) { try { recognition.stop(); } catch (_) {} recognition = null; }
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

// Resolve the best available Japanese voice.
// Chrome ships high-quality "Google 日本語" voices — prefer those.
function getVoicesAsync() {
  return new Promise(resolve => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) return resolve(voices);
    window.speechSynthesis.onvoiceschanged = () => resolve(window.speechSynthesis.getVoices());
  });
}

async function pickJapaneseVoice() {
  const voices = await getVoicesAsync();
  const ja = voices.filter(v => v.lang.startsWith('ja'));
  // Priority: Google > remote (network) > local
  return (
    ja.find(v => /google/i.test(v.name)) ||
    ja.find(v => !v.localService) ||
    ja[0] ||
    null
  );
}

let cachedVoice = null;

export async function speak(text, onEnd) {
  cancelSpeak();
  if (!cachedVoice) cachedVoice = await pickJapaneseVoice();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  if (cachedVoice) utter.voice = cachedVoice;
  utter.rate = 0.95;
  utter.pitch = 1.0;
  utter.volume = 1.0;

  utter.onend = () => { if (onEnd) onEnd(); };
  utter.onerror = () => { if (onEnd) onEnd(); };
  window.speechSynthesis.speak(utter);
}

export function cancelSpeak() {
  window.speechSynthesis.cancel();
}

// ─── Chime ────────────────────────────────────────────────────────────────────

export function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[880, 0, 0.15], [1108, 0.18, 0.12]].forEach(([freq, start, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq; osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    });
  } catch (_) {}
}
