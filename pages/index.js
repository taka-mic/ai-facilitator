// pages/index.js — AI Facilitator main page
// API key is stored server-side (.env.local). Never exposed to the browser.

import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import {
  createStore, addTranscriptChunk, getRecentTranscript, getFullTranscript,
  addInterventionRecord, mergeInsights,
} from '../lib/store';

// ─── API client (calls Next.js API routes) ───────────────────────────────────

async function apiCall(type, body) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, ...body }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

const SILENCE_MS = 1500;
const EVAL_INTERVAL_MS = 20000;
const EXTRACT_INTERVAL_MS = 60000;
const HAND_RAISED_TTL_S = 90;

// ─── Component ────────────────────────────────────────────────────────────────

export default function Home() {
  // Top-level phase
  const [phase, setPhase] = useState('setup'); // setup | running | ended

  // ── Setup state ──
  const [apiSetupError, setApiSetupError] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [agendaText, setAgendaText] = useState('');
  const [participants, setParticipants] = useState([]);
  const pidCounter = useRef(1);

  // ── Running state (display only) ──
  const [runState, setRunState] = useState('listening'); // listening | evaluating | hand_raised | speaking
  const [currentItemIdx, setCurrentItemIdx] = useState(0);
  const [timerDisplay, setTimerDisplay] = useState('0:00');
  const [timerOvertime, setTimerOvertime] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState([]); // { id, text, speakerName, isInterim }
  const [insights, setInsights] = useState({ decisions: [], actions: [], open_questions: [] });
  const [handRaisedMsg, setHandRaisedMsg] = useState('');
  const [handRaisedTTL, setHandRaisedTTL] = useState(HAND_RAISED_TTL_S);
  const [currentSpeakerId, setCurrentSpeakerId] = useState('');

  // ── Ended state ──
  const [minutes, setMinutes] = useState('');

  // ── Refs (mutable, no re-render) ──
  const store = useRef(createStore());
  const runStateRef = useRef('listening');
  const agendaTimerRef = useRef(null);
  const evalTimerRef = useRef(null);
  const extractTimerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const ttlTimerRef = useRef(null);
  const transcriptIdRef = useRef(0);
  const speechLib = useRef(null);
  const sttSupported = useRef(true);

  // ─── Load speech lib (browser only) ──────────────────────────────────────

  useEffect(() => {
    import('../lib/speech').then(mod => {
      speechLib.current = mod;
      sttSupported.current = mod.isSTTSupported();
    });
  }, []);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const setRunStateBoth = useCallback((s) => {
    runStateRef.current = s;
    setRunState(s);
  }, []);

  function fmt(seconds) {
    const abs = Math.abs(seconds);
    const m = Math.floor(abs / 60), s = abs % 60;
    return (seconds < 0 ? '-' : '') + `${m}:${String(s).padStart(2, '0')}`;
  }

  // ─── Setup ───────────────────────────────────────────────────────────────

  function addParticipant() {
    const id = `p${pidCounter.current++}`;
    setParticipants(prev => [...prev, { id, name: '' }]);
  }

  function updateParticipantName(id, name) {
    setParticipants(prev => prev.map(p => p.id === id ? { ...p, name } : p));
  }

  function removeParticipant(id) {
    setParticipants(prev => prev.filter(p => p.id !== id));
  }

  async function handleStart() {
    if (!agendaText.trim()) { setApiSetupError('目的・アジェンダを入力してください。'); return; }
    setApiSetupError('');
    setSetupLoading(true);
    try {
      const result = await apiCall('parse-agenda', { rawText: agendaText });
      const s = store.current;
      s.purpose = result.purpose;
      s.items = result.items.map(it => ({ ...it, elapsed_seconds: 0 }));
      s.participants = participants.filter(p => p.name.trim());
      s.currentItemIndex = 0;
      setCurrentItemIdx(0);
      startRunning();
    } catch (e) {
      setApiSetupError(`アジェンダ解析に失敗しました: ${e.message}\n内容を確認して再試行してください。`);
    } finally {
      setSetupLoading(false);
    }
  }

  // ─── Running ─────────────────────────────────────────────────────────────

  function startRunning() {
    setPhase('running');
    setRunStateBoth('listening');
    speechLib.current?.startSTT(onChunk);

    agendaTimerRef.current = setInterval(onAgendaTick, 1000);
    evalTimerRef.current   = setInterval(() => triggerEval('periodic'), EVAL_INTERVAL_MS);
    extractTimerRef.current = setInterval(runExtraction, EXTRACT_INTERVAL_MS);
  }

  function stopRunning() {
    clearInterval(agendaTimerRef.current);
    clearInterval(evalTimerRef.current);
    clearInterval(extractTimerRef.current);
    clearTimeout(silenceTimerRef.current);
    clearInterval(ttlTimerRef.current);
    speechLib.current?.stopSTT();
    speechLib.current?.cancelSpeak();
  }

  // Agenda timer tick
  function onAgendaTick() {
    const s = store.current;
    const item = s.items[s.currentItemIndex];
    if (!item) return;
    item.elapsed_seconds++;
    const allotted = item.allotted_minutes * 60;
    const remaining = allotted - item.elapsed_seconds;
    setTimerDisplay(fmt(remaining));
    setTimerOvertime(remaining < 0);

    if (item.elapsed_seconds === allotted ||
      (item.elapsed_seconds > allotted && item.elapsed_seconds % 30 === 0)) {
      triggerEval('timer');
    }
  }

  // STT chunk callback
  function onChunk({ text, isFinal, speaker }) {
    const s = store.current;
    addTranscriptChunk(s, text, isFinal, currentSpeakerId || null);

    const speakerName = currentSpeakerId
      ? (s.participants.find(p => p.id === currentSpeakerId)?.name || '')
      : '';

    if (isFinal) {
      const id = transcriptIdRef.current++;
      setTranscriptLines(prev => {
        const withoutInterim = prev.filter(l => !l.isInterim);
        return [...withoutInterim, { id, text, speakerName, isInterim: false }];
      });
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => triggerEval('silence'), SILENCE_MS);
    } else {
      const id = 'interim';
      setTranscriptLines(prev => {
        const withoutInterim = prev.filter(l => !l.isInterim);
        return [...withoutInterim, { id, text, speakerName, isInterim: true }];
      });
    }
  }

  // ─── Evaluation ──────────────────────────────────────────────────────────

  async function triggerEval(source) {
    if (runStateRef.current !== 'listening') return;
    setRunStateBoth('evaluating');
    try {
      const s = store.current;
      const item = s.items[s.currentItemIndex];
      const allotted = (item?.allotted_minutes ?? 0) * 60;
      const elapsed = item?.elapsed_seconds ?? 0;

      const result = await apiCall('evaluate', {
        ctx: {
          purpose: s.purpose,
          items: s.items,
          currentItemIndex: s.currentItemIndex,
          elapsed,
          remaining: Math.max(0, allotted - elapsed),
          recentTranscript: getRecentTranscript(s, 3),
          interventionHistory: s.interventionHistory,
        },
      });

      if (result.wants_to_speak) {
        s.pendingIntervention = { ...result, at: Date.now() };
        setHandRaisedMsg(result.spoken_message);
        setRunStateBoth('hand_raised');
        speechLib.current?.playChime();
        startTTL();
      } else {
        setRunStateBoth('listening');
      }
    } catch (e) {
      console.warn('Eval error:', e);
      setRunStateBoth('listening');
    }
  }

  function startTTL() {
    setHandRaisedTTL(HAND_RAISED_TTL_S);
    let remaining = HAND_RAISED_TTL_S;
    ttlTimerRef.current = setInterval(() => {
      remaining--;
      setHandRaisedTTL(remaining);
      if (remaining <= 0) expireHandRaised();
    }, 1000);
  }

  function clearTTL() {
    clearInterval(ttlTimerRef.current);
    ttlTimerRef.current = null;
  }

  function expireHandRaised() {
    clearTTL();
    const s = store.current;
    if (s.pendingIntervention) {
      addInterventionRecord(s, { ...s.pendingIntervention, outcome: 'expired' });
      s.pendingIntervention = null;
    }
    setRunStateBoth('listening');
  }

  function handleAllow() {
    if (runStateRef.current !== 'hand_raised') return;
    clearTTL();
    const s = store.current;
    const msg = s.pendingIntervention?.spoken_message || '';
    setRunStateBoth('speaking');
    speechLib.current?.speak(msg, () => {
      if (s.pendingIntervention) {
        addInterventionRecord(s, { ...s.pendingIntervention, outcome: 'spoken' });
        s.pendingIntervention = null;
      }
      setRunStateBoth('listening');
    });
  }

  function handleDismiss() {
    if (runStateRef.current !== 'hand_raised') return;
    clearTTL();
    const s = store.current;
    if (s.pendingIntervention) {
      addInterventionRecord(s, { ...s.pendingIntervention, outcome: 'dismissed' });
      s.pendingIntervention = null;
    }
    setRunStateBoth('listening');
  }

  // ─── Extraction ──────────────────────────────────────────────────────────

  async function runExtraction() {
    try {
      const s = store.current;
      const result = await apiCall('extract', {
        ctx: {
          currentItemTitle: s.items[s.currentItemIndex]?.title,
          recentTranscript: getRecentTranscript(s, 3),
        },
      });
      mergeInsights(s, result);
      setInsights({ ...s.insights });
    } catch (e) {
      console.warn('Extract error:', e);
    }
  }

  // ─── Agenda navigation ───────────────────────────────────────────────────

  function jumpToItem(idx) {
    runExtraction();
    const s = store.current;
    s.currentItemIndex = idx;
    s.items[idx].elapsed_seconds = 0;
    setCurrentItemIdx(idx);
    const item = s.items[idx];
    setTimerDisplay(fmt(item.allotted_minutes * 60));
    setTimerOvertime(false);
  }

  function handleNextItem() {
    const s = store.current;
    if (s.currentItemIndex < s.items.length - 1) jumpToItem(s.currentItemIndex + 1);
  }

  // ─── End meeting ─────────────────────────────────────────────────────────

  async function handleEndMeeting() {
    if (!confirm('会議を終了しますか？\n議事録を生成します。')) return;
    stopRunning();
    setPhase('ended');
    setMinutes('議事録を生成中...');
    try {
      const s = store.current;
      const result = await apiCall('minutes', {
        ctx: {
          purpose: s.purpose,
          participants: s.participants.map(p => p.name),
          items: s.items,
          fullTranscript: getFullTranscript(s),
          insights: s.insights,
        },
      });
      setMinutes(typeof result === 'string' ? result : result.text || JSON.stringify(result));
    } catch (e) {
      setMinutes(`議事録の生成に失敗しました: ${e.message}`);
    }
  }

  function downloadMinutes() {
    const blob = new Blob([minutes], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `議事録_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  const items = store.current.items;

  return (
    <>
      <Head>
        <title>AI ファシリテーター</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {!sttSupported.current && (
        <div className="browser-warning">
          ⚠️ このツールは Chrome または Edge が必要です。Safari / Firefox では音声認識が正常に動作しません。
        </div>
      )}

      {/* ══ SETUP ══════════════════════════════════════════════════════════ */}
      {phase === 'setup' && (
        <div className="screen-setup">
          <div className="card">
            <h1>🤝 <span className="accent">AI</span> ファシリテーター</h1>

            <div className="field">
              <label>会議の目的・アジェンダ</label>
              <textarea
                value={agendaText}
                onChange={e => setAgendaText(e.target.value)}
                placeholder={`例：\n【目的】来期予算案の審議・承認\n\n【アジェンダ】\n1. 開会・前回議事録確認（5分）\n2. 今期実績の報告（15分）\n3. 来期予算案の説明（20分）\n4. 質疑・承認（15分）\n5. その他・閉会（5分）`}
              />
            </div>

            <div className="field">
              <label>参加者（任意）</label>
              {participants.map(p => (
                <div key={p.id} className="participant-row">
                  <input
                    type="text" value={p.name} placeholder="参加者名"
                    onChange={e => updateParticipantName(p.id, e.target.value)}
                  />
                  <button className="btn-remove" onClick={() => removeParticipant(p.id)}>✕</button>
                </div>
              ))}
              <button className="btn-ghost" onClick={addParticipant}>＋ 参加者を追加</button>
            </div>

            {apiSetupError && <p className="error">{apiSetupError}</p>}

            <button className="btn-primary" onClick={handleStart} disabled={setupLoading}>
              {setupLoading ? '⏳ 解析中...' : '会議を開始する →'}
            </button>
          </div>
        </div>
      )}

      {/* ══ RUNNING ════════════════════════════════════════════════════════ */}
      {phase === 'running' && (
        <div className="screen-running">
          {/* Header */}
          <div className="running-header">
            <div className={`mic-dot ${runState}`} title={runState} />
            <div className="item-title">{items[currentItemIdx]?.title ?? '—'}</div>
            <div className={`timer ${timerOvertime ? 'overtime' : ''}`}>{timerDisplay}</div>
          </div>

          {/* Agenda nav */}
          <div className="agenda-nav">
            {items.map((it, i) => (
              <button
                key={it.id}
                className={`nav-item ${i === currentItemIdx ? 'active' : ''}`}
                onClick={() => jumpToItem(i)}
              >
                {i + 1}. {it.title}
              </button>
            ))}
          </div>

          {/* Main area */}
          <div className="running-main">
            {/* Transcript */}
            <div className="transcript-panel">
              <div className="panel-header">
                🎙 文字起こし
                <span className="speaker-label">話者:</span>
                <select
                  className="speaker-select"
                  value={currentSpeakerId}
                  onChange={e => setCurrentSpeakerId(e.target.value)}
                >
                  <option value="">（未選択）</option>
                  {store.current.participants.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="transcript-body">
                {transcriptLines.map(line => (
                  <p key={line.id} className={line.isInterim ? 'interim' : ''}>
                    {line.speakerName && <span className="speaker-tag">{line.speakerName}: </span>}
                    {line.text}
                  </p>
                ))}
              </div>
            </div>

            {/* Insights */}
            <div className="insights-panel">
              <div className="insight-section">
                <h3>✅ 決定事項</h3>
                <ul>{insights.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
              <div className="insight-section">
                <h3>📌 アクション</h3>
                <ul>{insights.actions.map((a, i) => (
                  <li key={i}>{a.who}：{a.what}{a.due ? `（期限: ${a.due}）` : ''}</li>
                ))}</ul>
              </div>
              <div className="insight-section grow">
                <h3>❓ 未解決の論点</h3>
                <ul>{insights.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              </div>
            </div>
          </div>

          {/* Hand-raised panel */}
          {runState === 'hand_raised' && (
            <div className="hand-raised-panel">
              <div className="hand-raised-header">🤚 AI が発言を希望しています</div>
              <div className="hand-raised-msg">{handRaisedMsg}</div>
              <div className="hand-raised-footer">
                <span className="ttl-label">{handRaisedTTL}秒</span>
                <button className="btn-dismiss" onClick={handleDismiss}>却下 ✕</button>
                <button className="btn-allow" onClick={handleAllow}>許可 ✓</button>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="running-footer">
            <button className="btn-ghost" onClick={handleNextItem}>⏭ 次の項目へ</button>
            <button className="btn-danger" onClick={handleEndMeeting}>🔴 会議を終了する</button>
          </div>
        </div>
      )}

      {/* ══ ENDED ══════════════════════════════════════════════════════════ */}
      {phase === 'ended' && (
        <div className="screen-ended">
          <div className="card">
            <h2>📝 議事録</h2>
            <pre className="minutes-output">{minutes}</pre>
            <div className="ended-actions">
              <button className="btn-primary" onClick={() => navigator.clipboard.writeText(minutes)}>
                📋 コピー
              </button>
              <button className="btn-ghost" onClick={downloadMinutes}>⬇ .md ダウンロード</button>
              <button className="btn-ghost muted" onClick={() => location.reload()}>
                ↩ 新しい会議を始める
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        :root {
          --bg: #0f1117; --surface: #1a1d27; --surface2: #252836;
          --border: #2e3248; --text: #e8eaf6; --text-muted: #7b82a8;
          --primary: #5c6bc0; --primary-h: #7986cb;
          --success: #43a047; --warning: #ffa726; --danger: #ef5350;
          --orange: #f57c00;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Hiragino Sans','Noto Sans JP',sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.6; }
        button { cursor: pointer; border: none; border-radius: 6px; padding: 8px 16px; font-size: 14px; font-family: inherit; transition: background .15s; }
        input, textarea, select { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: inherit; font-size: 14px; padding: 8px 12px; width: 100%; outline: none; }
        input:focus, textarea:focus, select:focus { border-color: var(--primary); }

        .browser-warning { background: var(--danger); color: #fff; padding: 12px 20px; text-align: center; font-weight: bold; }
        .accent { color: var(--primary); }
        .error { color: var(--danger); font-size: 13px; white-space: pre-wrap; }

        /* Buttons */
        .btn-primary { background: var(--primary); color: #fff; font-size: 16px; padding: 12px; font-weight: 600; width: 100%; }
        .btn-primary:hover:not(:disabled) { background: var(--primary-h); }
        .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
        .btn-ghost { background: var(--surface2); color: var(--text); }
        .btn-ghost:hover { background: var(--border); }
        .btn-ghost.muted { color: var(--text-muted); }
        .btn-remove { background: var(--surface2); color: var(--text-muted); padding: 8px 10px; flex-shrink: 0; }
        .btn-remove:hover { background: var(--danger); color: #fff; }
        .btn-danger { background: var(--danger); color: #fff; font-weight: 600; }
        .btn-danger:hover { filter: brightness(1.1); }
        .btn-allow { background: var(--success); color: #fff; font-weight: 600; }
        .btn-allow:hover { filter: brightness(1.1); }
        .btn-dismiss { background: var(--surface2); color: var(--text-muted); }
        .btn-dismiss:hover { background: var(--danger); color: #fff; }

        /* Setup */
        .screen-setup { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; min-height: 100vh; }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; width: 100%; max-width: 640px; display: flex; flex-direction: column; gap: 20px; }
        .card h1 { font-size: 22px; } .card h2 { font-size: 18px; }
        .field label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
        .field textarea { height: 180px; resize: vertical; }
        .participant-row { display: flex; gap: 8px; margin-bottom: 6px; }

        /* Running */
        .screen-running { display: flex; flex-direction: column; height: 100vh; overflow: hidden; position: relative; }
        .running-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
        .mic-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; transition: background .3s; }
        .mic-dot.listening  { background: var(--success); animation: pulse 1.5s infinite; }
        .mic-dot.evaluating { background: var(--warning); }
        .mic-dot.hand_raised { background: var(--orange); animation: pulse .5s infinite; }
        .mic-dot.speaking   { background: var(--primary); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        .item-title { font-size: 16px; font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .timer { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--success); flex-shrink: 0; min-width: 70px; text-align: right; }
        .timer.overtime { color: var(--danger); }

        .agenda-nav { display: flex; gap: 6px; padding: 8px 20px; background: var(--surface); border-bottom: 1px solid var(--border); overflow-x: auto; flex-shrink: 0; }
        .nav-item { background: var(--surface2); color: var(--text-muted); white-space: nowrap; font-size: 12px; padding: 5px 10px; border-radius: 20px; }
        .nav-item:hover { background: var(--border); color: var(--text); }
        .nav-item.active { background: var(--primary); color: #fff; }

        .running-main { display: flex; flex: 1; overflow: hidden; }

        .transcript-panel { flex: 1.5; display: flex; flex-direction: column; border-right: 1px solid var(--border); overflow: hidden; }
        .panel-header { padding: 10px 16px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; align-items: center; gap: 10px; }
        .speaker-label { font-weight: normal; font-size: 11px; color: var(--text-muted); margin-left: auto; }
        .speaker-select { font-size: 12px; padding: 4px 8px; width: auto; }
        .transcript-body { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 14px; line-height: 1.8; }
        .transcript-body p { margin-bottom: 4px; }
        .speaker-tag { font-weight: 700; color: var(--primary-h); margin-right: 4px; }
        .interim { color: var(--text-muted); }

        .insights-panel { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; }
        .insight-section { border-bottom: 1px solid var(--border); padding: 10px 14px; overflow-y: auto; }
        .insight-section.grow { flex: 1; border-bottom: none; }
        .insight-section h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); margin-bottom: 8px; }
        .insight-section ul { list-style: none; padding: 0; }
        .insight-section li { font-size: 13px; padding: 3px 0; border-bottom: 1px solid var(--border); }
        .insight-section li:last-child { border-bottom: none; }

        .hand-raised-panel { position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%); background: var(--surface); border: 2px solid var(--orange); border-radius: 12px; padding: 16px 20px; min-width: 340px; max-width: 480px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.5); z-index: 100; }
        .hand-raised-header { font-weight: 700; color: var(--orange); font-size: 13px; }
        .hand-raised-msg { font-size: 15px; line-height: 1.6; }
        .hand-raised-footer { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
        .ttl-label { font-size: 12px; color: var(--text-muted); margin-right: auto; }

        .running-footer { padding: 10px 20px; background: var(--surface); border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; flex-shrink: 0; }

        /* Ended */
        .screen-ended { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; min-height: 100vh; }
        .screen-ended .card { max-width: 760px; }
        .minutes-output { white-space: pre-wrap; font-size: 14px; line-height: 1.8; background: var(--surface2); border-radius: 8px; padding: 16px; min-height: 300px; max-height: 60vh; overflow-y: auto; font-family: inherit; }
        .ended-actions { display: flex; gap: 10px; flex-wrap: wrap; }
        .ended-actions .btn-ghost.muted { margin-left: auto; }
      `}</style>
    </>
  );
}
