// agenda.js — in-memory store for all meeting data

export const store = {
  apiKey: localStorage.getItem('facilitator_api_key') || '',

  // Setup
  purpose: '',
  items: [],          // AgendaItem[]
  participants: [],   // Participant[]

  // Runtime
  currentItemIndex: 0,
  transcript: [],     // TranscriptChunk[]
  interventionHistory: [], // InterventionRecord[]
  pendingIntervention: null,

  // Extraction results (cumulative)
  insights: {
    decisions: [],
    actions: [],
    open_questions: [],
  },

  // Final output
  minutes: '',
};

export function saveApiKey(key) {
  store.apiKey = key;
  localStorage.setItem('facilitator_api_key', key);
}

export function addTranscriptChunk(text, isFinal, speaker = null) {
  const currentItem = store.items[store.currentItemIndex];
  store.transcript.push({
    at: Date.now(),
    text,
    isFinal,
    speaker,
    agendaItemId: currentItem ? currentItem.id : null,
  });
}

export function getRecentTranscript(minutes = 3) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return store.transcript
    .filter(c => c.isFinal && c.at >= cutoff)
    .map(c => {
      const name = c.speaker
        ? (store.participants.find(p => p.id === c.speaker)?.name || c.speaker)
        : null;
      return name ? `${name}: ${c.text}` : c.text;
    })
    .join('\n');
}

export function getFullTranscript() {
  return store.transcript
    .filter(c => c.isFinal)
    .map(c => {
      const name = c.speaker
        ? (store.participants.find(p => p.id === c.speaker)?.name || c.speaker)
        : null;
      return name ? `${name}: ${c.text}` : c.text;
    })
    .join('\n');
}

export function addInterventionRecord(record) {
  store.interventionHistory.push(record);
  // keep last 20
  if (store.interventionHistory.length > 20) {
    store.interventionHistory.shift();
  }
}

export function mergeInsights(newInsights) {
  const { decisions, actions, open_questions } = newInsights;

  for (const d of decisions) {
    if (!store.insights.decisions.includes(d)) {
      store.insights.decisions.push(d);
    }
  }

  for (const a of actions) {
    const exists = store.insights.actions.some(
      x => x.who === a.who && x.what === a.what
    );
    if (!exists) store.insights.actions.push(a);
  }

  for (const q of open_questions) {
    if (!store.insights.open_questions.includes(q)) {
      store.insights.open_questions.push(q);
    }
  }
}
