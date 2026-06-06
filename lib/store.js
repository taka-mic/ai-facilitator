// lib/store.js — in-memory meeting data store (browser-side)

export function createStore() {
  return {
    purpose: '',
    items: [],           // { id, title, allotted_minutes, elapsed_seconds }
    participants: [],    // { id, name }
    currentItemIndex: 0,
    transcript: [],      // { at, text, isFinal, speaker, agendaItemId }
    interventionHistory: [],
    pendingIntervention: null,
    insights: { decisions: [], actions: [], open_questions: [] },
    minutes: '',
  };
}

export function addTranscriptChunk(store, text, isFinal, speakerId) {
  const item = store.items[store.currentItemIndex];
  store.transcript.push({
    at: Date.now(), text, isFinal,
    speaker: speakerId,
    agendaItemId: item?.id ?? null,
  });
}

export function getRecentTranscript(store, minutes = 3) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return store.transcript
    .filter(c => c.isFinal && c.at >= cutoff)
    .map(c => {
      const p = c.speaker ? store.participants.find(p => p.id === c.speaker) : null;
      return p ? `${p.name}: ${c.text}` : c.text;
    })
    .join('\n');
}

export function getFullTranscript(store) {
  return store.transcript
    .filter(c => c.isFinal)
    .map(c => {
      const p = c.speaker ? store.participants.find(p => p.id === c.speaker) : null;
      return p ? `${p.name}: ${c.text}` : c.text;
    })
    .join('\n');
}

export function addInterventionRecord(store, record) {
  store.interventionHistory.push(record);
  if (store.interventionHistory.length > 20) store.interventionHistory.shift();
}

export function mergeInsights(store, next) {
  for (const d of next.decisions) {
    if (!store.insights.decisions.includes(d)) store.insights.decisions.push(d);
  }
  for (const a of next.actions) {
    const exists = store.insights.actions.some(x => x.who === a.who && x.what === a.what);
    if (!exists) store.insights.actions.push(a);
  }
  for (const q of next.open_questions) {
    if (!store.insights.open_questions.includes(q)) store.insights.open_questions.push(q);
  }
}
