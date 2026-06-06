// speech.js — STT/TTS wrapper
// Phase 2: replace startSTT() internals with Deepgram/AssemblyAI.
// The onChunk callback interface must stay the same.

// onChunk: ({ text: string, isFinal: boolean, speaker: string|null }) => void
let recognition = null;
let onChunkCallback = null;

export function isSTTSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function startSTT(onChunk) {
  onChunkCallback = onChunk;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      onChunk({
        text: result[0].transcript,
        isFinal: result.isFinal,
        speaker: null, // Phase 2: diarization label here
      });
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech') return; // benign
    console.warn('STT error:', e.error);
    // auto-restart on recoverable errors
    if (['network', 'audio-capture'].includes(e.error)) {
      setTimeout(() => restartSTT(), 1000);
    }
  };

  recognition.onend = () => {
    // Auto-restart if we're supposed to still be listening
    if (onChunkCallback) {
      setTimeout(() => {
        if (onChunkCallback) recognition.start();
      }, 300);
    }
  };

  recognition.start();
}

function restartSTT() {
  if (!onChunkCallback) return;
  try { recognition.stop(); } catch (_) {}
  setTimeout(() => {
    if (onChunkCallback) recognition.start();
  }, 500);
}

export function stopSTT() {
  onChunkCallback = null;
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
    recognition = null;
  }
}

// TTS
let currentUtterance = null;

export function speak(text, onEnd) {
  cancelSpeak();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  utter.rate = 1.0;
  utter.onend = () => {
    currentUtterance = null;
    if (onEnd) onEnd();
  };
  utter.onerror = () => {
    currentUtterance = null;
    if (onEnd) onEnd();
  };
  currentUtterance = utter;
  window.speechSynthesis.speak(utter);
}

export function cancelSpeak() {
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

// Chime sound (Web Audio API)
export function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.8);
  } catch (_) {}
}
