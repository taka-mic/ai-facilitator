// app.js — state machine and main loop
// WARNING: Claude API key is exposed client-side. For local verification only. Do NOT deploy.

import {
  store, saveApiKey,
  addTranscriptChunk, getRecentTranscript, getFullTranscript,
  addInterventionRecord, mergeInsights,
} from './agenda.js';

import { parseAgenda, evaluateIntervention, extractInsights, generateMinutes } from './claude.js';
import { isSTTSupported, startSTT, stopSTT, speak, cancelSpeak, playChime } from './speech.js';

// ─── State ────────────────────────────────────────────────────────────────────

// IDLE | SETUP | RUNNING/LISTENING | RUNNING/EVALUATING | RUNNING/HAND_RAISED | RUNNING/SPEAKING | ENDED
let state = 'IDLE';
let subState = null; // LISTENING | EVALUATING | HAND_RAISED | SPEAKING

let agendaTimerInterval = null;
let evaluationInterval = null;
let extractionInterval = null;
let handRaisedTTLTimeout = null;
let silenceTimeout = null;
let currentSpeakerId = null; // Participant.id or null

const SILENCE_THRESHOLD_MS = 1500;
const EVALUATION_INTERVAL_MS = 20000;
const EXTRACTION_INTERVAL_MS = 60000;
const HAND_RAISED_TTL_MS = 90000;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const screens = {
  setup: document.getElementById('screen-setup'),
  running: document.getElementById('screen-running'),
  ended: document.getElementById('screen-ended'),
};

// Setup
const apiKeyInput = document.getElementById('api-key');
const agendaInput = document.getElementById('agenda-input');
const participantList = document.getElementById('participant-list');
const addParticipantBtn = document.getElementById('add-participant-btn');
const startBtn = document.getElementById('start-btn');
const setupError = document.getElementById('setup-error');
const setupSpinner = document.getElementById('setup-spinner');

// Running
const currentItemTitle = document.getElementById('current-item-title');
const currentItemTimer = document.getElementById('current-item-timer');
const agendaNav = document.getElementById('agenda-nav');
const transcriptEl = document.getElementById('transcript');
const speakerSelect = document.getElementById('speaker-select');
const decisionsList = document.getElementById('decisions-list');
const actionsList = document.getElementById('actions-list');
const questionsList = document.getElementById('questions-list');
const handRaisedPanel = document.getElementById('hand-raised-panel');
const handRaisedMessage = document.getElementById('hand-raised-message');
const handRaisedTTL = document.getElementById('hand-raised-ttl');
const allowBtn = document.getElementById('allow-btn');
const dismissBtn = document.getElementById('dismiss-btn');
const nextItemBtn = document.getElementById('next-item-btn');
const endMeetingBtn = document.getElementById('end-meeting-btn');
const micStatus = document.getElementById('mic-status');

// Ended
const minutesOutput = document.getElementById('minutes-output');
const copyBtn = document.getElementById('copy-btn');
const downloadBtn = document.getElementById('download-btn');
const newMeetingBtn = document.getElementById('new-meeting-btn');

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!isSTTSupported()) {
    document.getElementById('browser-warning').style.display = 'block';
  }

  // Restore API key
  if (store.apiKey) apiKeyInput.value = store.apiKey;

  apiKeyInput.addEventListener('change', () => saveApiKey(apiKeyInput.value.trim()));

  // Participants
  addParticipantBtn.addEventListener('click', () => addParticipantRow());
  renderParticipants();

  // Start button
  startBtn.addEventListener('click', onStartMeeting);

  // Running controls
  allowBtn.addEventListener('click', onAllow);
  dismissBtn.addEventListener('click', onDismiss);
  nextItemBtn.addEventListener('click', onNextItem);
  endMeetingBtn.addEventListener('click', onEndMeeting);
  speakerSelect.addEventListener('change', () => {
    currentSpeakerId = speakerSelect.value || null;
  });

  // Ended controls
  copyBtn.addEventListener('click', () => navigator.clipboard.writeText(store.minutes));
  downloadBtn.addEventListener('click', downloadMinutes);
  newMeetingBtn.addEventListener('click', () => location.reload());

  showScreen('setup');
}

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.style.display = k === name ? 'flex' : 'none';
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let participantIdCounter = 1;

function addParticipantRow(name = '') {
  const id = `p${participantIdCounter++}`;
  store.participants.push({ id, name });
  renderParticipants();
  return id;
}

function renderParticipants() {
  participantList.innerHTML = '';
  store.participants.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML = `
      <input type="text" value="${escHtml(p.name)}" placeholder="参加者名" data-idx="${idx}" />
      <button class="remove-btn" data-idx="${idx}">✕</button>
    `;
    participantList.appendChild(row);
  });

  participantList.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', e => {
      store.participants[parseInt(e.target.dataset.idx)].name = e.target.value;
      updateSpeakerSelect();
    });
  });
  participantList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      store.participants.splice(parseInt(e.target.dataset.idx), 1);
      renderParticipants();
    });
  });
  updateSpeakerSelect();
}

async function onStartMeeting() {
  const rawText = agendaInput.value.trim();
  if (!rawText) { showSetupError('目的・アジェンダを入力してください。'); return; }
  if (!store.apiKey) { showSetupError('Claude API キーを入力してください。'); return; }

  startBtn.disabled = true;
  setupSpinner.style.display = 'inline-block';
  setupError.textContent = '';

  try {
    const result = await parseAgenda(rawText);
    store.purpose = result.purpose;
    store.items = result.items.map(it => ({ ...it, elapsed_seconds: 0 }));
    store.currentItemIndex = 0;
    startRunning();
  } catch (e) {
    showSetupError(`アジェンダ解析に失敗しました: ${e.message}\n内容を確認して再試行してください。`);
    startBtn.disabled = false;
    setupSpinner.style.display = 'none';
  }
}

function showSetupError(msg) {
  setupError.textContent = msg;
}

// ─── Running ──────────────────────────────────────────────────────────────────

function startRunning() {
  showScreen('running');
  state = 'RUNNING';

  renderAgendaNav();
  updateSpeakerSelect();
  setSubState('LISTENING');

  startSTT(onTranscriptChunk);

  // Agenda timer: tick every second
  agendaTimerInterval = setInterval(onAgendaTick, 1000);

  // Evaluation interval: every 20s
  evaluationInterval = setInterval(() => triggerEvaluation('periodic'), EVALUATION_INTERVAL_MS);

  // Extraction interval: every 60s
  extractionInterval = setInterval(runExtraction, EXTRACTION_INTERVAL_MS);
}

function onAgendaTick() {
  const item = store.items[store.currentItemIndex];
  if (!item) return;
  item.elapsed_seconds++;

  const allotted = item.allotted_minutes * 60;
  const remaining = Math.max(0, allotted - item.elapsed_seconds);

  currentItemTitle.textContent = item.title;
  currentItemTimer.textContent = formatTime(remaining);
  currentItemTimer.classList.toggle('overtime', item.elapsed_seconds > allotted);

  // Time-over trigger (once, at exact threshold + every 30s after)
  if (item.elapsed_seconds === allotted || (item.elapsed_seconds > allotted && item.elapsed_seconds % 30 === 0)) {
    triggerEvaluation('timer');
  }
}

// ─── STT callback ─────────────────────────────────────────────────────────────

function onTranscriptChunk({ text, isFinal, speaker }) {
  addTranscriptChunk(text, isFinal, currentSpeakerId);
  renderTranscript(text, isFinal);

  if (isFinal) {
    // Silence detection: reset timer on each final chunk
    clearTimeout(silenceTimeout);
    silenceTimeout = setTimeout(() => triggerEvaluation('silence'), SILENCE_THRESHOLD_MS);
  }
}

function renderTranscript(text, isFinal) {
  // Remove previous interim span
  const prev = transcriptEl.querySelector('.interim');
  if (prev) prev.remove();

  if (isFinal) {
    const p = document.createElement('p');
    const speaker = store.participants.find(p => p.id === currentSpeakerId);
    if (speaker) {
      const tag = document.createElement('span');
      tag.className = 'speaker-tag';
      tag.textContent = speaker.name + ': ';
      p.appendChild(tag);
    }
    p.append(text);
    transcriptEl.appendChild(p);
  } else {
    const span = document.createElement('span');
    span.className = 'interim';
    span.textContent = text;
    transcriptEl.appendChild(span);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

async function triggerEvaluation(source) {
  if (subState !== 'LISTENING') return; // guard multi-trigger

  setSubState('EVALUATING');
  try {
    const item = store.items[store.currentItemIndex];
    const allotted = item ? item.allotted_minutes * 60 : 0;
    const elapsed = item ? item.elapsed_seconds : 0;
    const remaining = Math.max(0, allotted - elapsed);

    const ctx = {
      purpose: store.purpose,
      items: store.items,
      currentItemIndex: store.currentItemIndex,
      elapsed,
      remaining,
      recentTranscript: getRecentTranscript(3),
      interventionHistory: store.interventionHistory,
    };

    const result = await evaluateIntervention(ctx);

    if (result.wants_to_speak) {
      store.pendingIntervention = { ...result, at: Date.now() };
      setSubState('HAND_RAISED');
      playChime();
      handRaisedMessage.textContent = result.spoken_message;
      handRaisedPanel.style.display = 'flex';
      startHandRaisedTTL();
    } else {
      setSubState('LISTENING');
    }
  } catch (e) {
    console.warn('Evaluation error:', e);
    setSubState('LISTENING');
  }
}

function startHandRaisedTTL() {
  let remaining = HAND_RAISED_TTL_MS / 1000;
  handRaisedTTL.textContent = `${remaining}秒`;

  handRaisedTTLTimeout = setInterval(() => {
    remaining--;
    handRaisedTTL.textContent = `${remaining}秒`;
    if (remaining <= 0) expireHandRaised();
  }, 1000);
}

function clearHandRaisedTTL() {
  clearInterval(handRaisedTTLTimeout);
  handRaisedTTLTimeout = null;
}

function expireHandRaised() {
  clearHandRaisedTTL();
  if (store.pendingIntervention) {
    addInterventionRecord({ ...store.pendingIntervention, outcome: 'expired' });
    store.pendingIntervention = null;
  }
  handRaisedPanel.style.display = 'none';
  setSubState('LISTENING');
}

function onAllow() {
  if (subState !== 'HAND_RAISED') return;
  clearHandRaisedTTL();
  handRaisedPanel.style.display = 'none';
  setSubState('SPEAKING');

  const msg = store.pendingIntervention?.spoken_message || '';
  speak(msg, () => {
    if (store.pendingIntervention) {
      addInterventionRecord({ ...store.pendingIntervention, outcome: 'spoken' });
      store.pendingIntervention = null;
    }
    setSubState('LISTENING');
  });
}

function onDismiss() {
  if (subState !== 'HAND_RAISED') return;
  clearHandRaisedTTL();
  if (store.pendingIntervention) {
    addInterventionRecord({ ...store.pendingIntervention, outcome: 'dismissed' });
    store.pendingIntervention = null;
  }
  handRaisedPanel.style.display = 'none';
  setSubState('LISTENING');
}

// ─── Extraction ───────────────────────────────────────────────────────────────

async function runExtraction() {
  try {
    const ctx = {
      currentItem: store.items[store.currentItemIndex],
      recentTranscript: getRecentTranscript(3),
    };
    const result = await extractInsights(ctx);
    mergeInsights(result);
    renderInsights();
  } catch (e) {
    console.warn('Extraction error:', e);
  }
}

function renderInsights() {
  renderList(decisionsList, store.insights.decisions);
  renderList(questionsList, store.insights.open_questions);

  actionsList.innerHTML = '';
  store.insights.actions.forEach(a => {
    const li = document.createElement('li');
    li.textContent = `${a.who}：${a.what}${a.due ? `（期限: ${a.due}）` : ''}`;
    actionsList.appendChild(li);
  });
}

function renderList(el, items) {
  el.innerHTML = '';
  items.forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    el.appendChild(li);
  });
}

// ─── Agenda navigation ────────────────────────────────────────────────────────

function renderAgendaNav() {
  agendaNav.innerHTML = '';
  store.items.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.textContent = `${i + 1}. ${item.title}`;
    btn.className = 'agenda-nav-item' + (i === store.currentItemIndex ? ' active' : '');
    btn.addEventListener('click', () => jumpToItem(i));
    agendaNav.appendChild(btn);
  });

  const item = store.items[store.currentItemIndex];
  if (item) {
    currentItemTitle.textContent = item.title;
    currentItemTimer.textContent = formatTime(item.allotted_minutes * 60);
  }
}

function jumpToItem(index) {
  runExtraction(); // extract before switching
  store.currentItemIndex = index;
  store.items[index].elapsed_seconds = 0;
  renderAgendaNav();
}

function onNextItem() {
  if (store.currentItemIndex < store.items.length - 1) {
    jumpToItem(store.currentItemIndex + 1);
  }
}

// ─── End meeting ──────────────────────────────────────────────────────────────

async function onEndMeeting() {
  if (!confirm('会議を終了しますか？\n議事録を生成します。')) return;

  stopRunning();
  showScreen('ended');
  minutesOutput.textContent = '議事録を生成中...';

  try {
    const ctx = {
      purpose: store.purpose,
      participants: store.participants,
      items: store.items,
      fullTranscript: getFullTranscript(),
      insights: store.insights,
    };
    store.minutes = await generateMinutes(ctx);
    minutesOutput.textContent = store.minutes;
  } catch (e) {
    minutesOutput.textContent = `議事録の生成に失敗しました: ${e.message}`;
  }
}

function stopRunning() {
  clearInterval(agendaTimerInterval);
  clearInterval(evaluationInterval);
  clearInterval(extractionInterval);
  clearTimeout(silenceTimeout);
  clearHandRaisedTTL();
  stopSTT();
  cancelSpeak();
  state = 'ENDED';
}

function downloadMinutes() {
  const blob = new Blob([store.minutes], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `議事録_${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setSubState(s) {
  subState = s;
  micStatus.className = 'mic-status ' + s.toLowerCase();
  micStatus.title = s;
}

function updateSpeakerSelect() {
  const current = speakerSelect.value;
  speakerSelect.innerHTML = '<option value="">（話者未選択）</option>';
  store.participants.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name || '（名前なし）';
    if (p.id === current) opt.selected = true;
    speakerSelect.appendChild(opt);
  });
}

function formatTime(seconds) {
  const m = Math.floor(Math.abs(seconds) / 60);
  const s = Math.abs(seconds) % 60;
  return (seconds < 0 ? '-' : '') + `${m}:${String(s).padStart(2, '0')}`;
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
