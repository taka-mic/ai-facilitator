// pages/index.js — AI Facilitator main page
// API key is stored server-side (.env.local). Never exposed to the browser.

import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import {
  createStore, addTranscriptChunk, getRecentTranscript, getFullTranscript,
  addInterventionRecord, mergeInsights,
} from '../lib/store';

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

export default function Home() {
  const [phase, setPhase] = useState('setup');

  // Setup
  const [setupError, setSetupError] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [agendaText, setAgendaText] = useState('');
  const [participants, setParticipants] = useState([]);
  const pidCounter = useRef(1);

  // Running
  const [runState, setRunState] = useState('listening');
  const [currentItemIdx, setCurrentItemIdx] = useState(0);
  const [timerDisplay, setTimerDisplay] = useState('0:00');
  const [timerOvertime, setTimerOvertime] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [insights, setInsights] = useState({ decisions: [], actions: [], open_questions: [] });
  const [handRaisedMsg, setHandRaisedMsg] = useState('');
  const [handRaisedTTL, setHandRaisedTTL] = useState(HAND_RAISED_TTL_S);
  const [currentSpeakerId, setCurrentSpeakerId] = useState('');
  const [activeTab, setActiveTab] = useState('transcript'); // transcript | insights
  const [micOn, setMicOn] = useState(false);
  const [micError, setMicError] = useState('');

  // Ended
  const [minutes, setMinutes] = useState('');

  // Refs
  const store = useRef(createStore());
  const runStateRef = useRef('listening');
  const hasAgendaRef = useRef(false); // false = minutes-only mode
  const agendaTimerRef = useRef(null);
  const evalTimerRef = useRef(null);
  const extractTimerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const ttlTimerRef = useRef(null);
  const transcriptIdRef = useRef(0);
  const speechLib = useRef(null);
  const [sttOk, setSttOk] = useState(true);

  useEffect(() => {
    import('../lib/speech').then(mod => {
      speechLib.current = mod;
      setSttOk(mod.isSTTSupported());
    });
  }, []);

  const setRunStateBoth = useCallback((s) => {
    runStateRef.current = s;
    setRunState(s);
  }, []);

  function fmt(seconds) {
    const abs = Math.abs(seconds);
    return (seconds < 0 ? '-' : '') + `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

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
    setSetupError('');
    const s = store.current;
    s.participants = participants.filter(p => p.name.trim());

    if (agendaText.trim()) {
      // Agenda mode: parse and run full facilitation
      setSetupLoading(true);
      try {
        const result = await apiCall('parse-agenda', { rawText: agendaText });
        s.purpose = result.purpose;
        s.items = result.items.map(it => ({ ...it, elapsed_seconds: 0 }));
        s.currentItemIndex = 0;
        setCurrentItemIdx(0);
        hasAgendaRef.current = true;
      } catch (e) {
        setSetupError(`アジェンダ解析に失敗しました: ${e.message}\n内容を確認して再試行してください。`);
        setSetupLoading(false);
        return;
      }
      setSetupLoading(false);
    } else {
      // Minutes-only mode: skip facilitation, just record
      s.purpose = '';
      s.items = [];
      hasAgendaRef.current = false;
    }

    startRunning();
  }

  // ── Running ────────────────────────────────────────────────────────────────

  function startRunning() {
    setPhase('running');
    setRunStateBoth('listening');
    // STT is NOT started here — user must press the mic button explicitly

    if (hasAgendaRef.current) {
      agendaTimerRef.current = setInterval(onAgendaTick, 1000);
      evalTimerRef.current   = setInterval(() => triggerEval('periodic'), EVAL_INTERVAL_MS);
    }
    extractTimerRef.current = setInterval(runExtraction, EXTRACT_INTERVAL_MS);
  }

  function toggleMic() {
    if (micOn) {
      speechLib.current?.stopSTT();
      setMicOn(false);
      setRunStateBoth('listening');
    } else {
      speechLib.current?.startSTT(onChunk);
      setMicOn(true);
    }
  }

  function stopRunning() {
    clearInterval(agendaTimerRef.current);
    clearInterval(evalTimerRef.current);
    clearInterval(extractTimerRef.current);
    clearTimeout(silenceTimerRef.current);
    clearInterval(ttlTimerRef.current);
    speechLib.current?.stopSTT();
    speechLib.current?.cancelSpeak();
    setMicOn(false);
  }

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

  function onChunk({ text, isFinal, speaker, error, info }) {
    // Error from STT (permission denied, API failure, etc.)
    if (error) {
      setMicError(error);
      setMicOn(false);
      return;
    }
    // Informational message (e.g. "recording started")
    if (info) {
      setMicError('');
      setTranscriptLines(prev => [...prev.filter(l => !l.isInfo), { id: 'info', text: info, speakerName: '', isInterim: false, isInfo: true }]);
      return;
    }

    setMicError('');
    const s = store.current;
    if (isFinal && text.trim()) {
      addTranscriptChunk(s, text, true, currentSpeakerId || null);
    }
    const speakerName = currentSpeakerId
      ? (s.participants.find(p => p.id === currentSpeakerId)?.name || '') : '';

    if (isFinal) {
      if (!text.trim()) {
        // Clear interim only
        setTranscriptLines(prev => prev.filter(l => !l.isInterim));
        return;
      }
      const id = transcriptIdRef.current++;
      setTranscriptLines(prev => [...prev.filter(l => !l.isInterim && !l.isInfo), { id, text, speakerName, isInterim: false, isInfo: false }]);
      if (hasAgendaRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = setTimeout(() => triggerEval('silence'), SILENCE_MS);
      }
    } else {
      setTranscriptLines(prev => [...prev.filter(l => !l.isInterim && !l.isInfo), { id: 'interim', text, speakerName, isInterim: true, isInfo: false }]);
    }
  }

  // ── Evaluation (agenda mode only) ─────────────────────────────────────────

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
          purpose: s.purpose, items: s.items,
          currentItemIndex: s.currentItemIndex,
          elapsed, remaining: Math.max(0, allotted - elapsed),
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
    let r = HAND_RAISED_TTL_S;
    ttlTimerRef.current = setInterval(() => {
      r--;
      setHandRaisedTTL(r);
      if (r <= 0) expireHandRaised();
    }, 1000);
  }

  function clearTTL() { clearInterval(ttlTimerRef.current); ttlTimerRef.current = null; }

  function expireHandRaised() {
    clearTTL();
    const s = store.current;
    if (s.pendingIntervention) { addInterventionRecord(s, { ...s.pendingIntervention, outcome: 'expired' }); s.pendingIntervention = null; }
    setRunStateBoth('listening');
  }

  function handleAllow() {
    if (runStateRef.current !== 'hand_raised') return;
    clearTTL();
    const s = store.current;
    const msg = s.pendingIntervention?.spoken_message || '';
    setRunStateBoth('speaking');
    speechLib.current?.speak(msg, () => {
      if (s.pendingIntervention) { addInterventionRecord(s, { ...s.pendingIntervention, outcome: 'spoken' }); s.pendingIntervention = null; }
      setRunStateBoth('listening');
    });
  }

  function handleDismiss() {
    if (runStateRef.current !== 'hand_raised') return;
    clearTTL();
    const s = store.current;
    if (s.pendingIntervention) { addInterventionRecord(s, { ...s.pendingIntervention, outcome: 'dismissed' }); s.pendingIntervention = null; }
    setRunStateBoth('listening');
  }

  // ── Extraction ─────────────────────────────────────────────────────────────

  async function runExtraction() {
    try {
      const s = store.current;
      const result = await apiCall('extract', {
        ctx: { currentItemTitle: s.items[s.currentItemIndex]?.title, recentTranscript: getRecentTranscript(s, 3) },
      });
      mergeInsights(s, result);
      setInsights({ ...s.insights });
    } catch (e) { console.warn('Extract error:', e); }
  }

  // ── Agenda nav ─────────────────────────────────────────────────────────────

  function jumpToItem(idx) {
    runExtraction();
    const s = store.current;
    s.currentItemIndex = idx; s.items[idx].elapsed_seconds = 0;
    setCurrentItemIdx(idx);
    setTimerDisplay(fmt(s.items[idx].allotted_minutes * 60));
    setTimerOvertime(false);
  }

  function handleNextItem() {
    const s = store.current;
    if (s.currentItemIndex < s.items.length - 1) jumpToItem(s.currentItemIndex + 1);
  }

  // ── End meeting ────────────────────────────────────────────────────────────

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
    a.href = url; a.download = `議事録_${new Date().toISOString().slice(0, 10)}.md`; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const items = store.current.items;
  const hasAgenda = hasAgendaRef.current;

  return (
    <>
      <Head>
        <title>AI ファシリテーター</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </Head>

      {!sttOk && (
        <div className="browser-warning">
          ⚠️ お使いのブラウザは音声認識に非対応です。Chrome / Android Chrome をお試しください。
        </div>
      )}

      {/* ══ SETUP ══════════════════════════════════════════════════════════ */}
      {phase === 'setup' && (
        <div className="screen-setup">
          <div className="card">
            <h1>🤝 <span className="accent">AI</span> ファシリテーター</h1>

            <div className="field">
              <label>会議の目的・アジェンダ <span className="optional">（任意）</span></label>
              <textarea
                value={agendaText}
                onChange={e => setAgendaText(e.target.value)}
                placeholder={`入力なしでも開始できます（議事録のみ生成）\n\n【目的】来期予算案の審議・承認\n\n【アジェンダ】\n1. 開会・前回議事録確認（5分）\n2. 今期実績の報告（15分）\n3. 来期予算案の説明（20分）\n4. 質疑・承認（15分）\n5. その他・閉会（5分）`}
              />
              {!agendaText.trim() && (
                <p className="hint">💡 未入力の場合、AI の進行補助なしで録音・議事録生成のみ行います</p>
              )}
            </div>

            <div className="field">
              <label>参加者 <span className="optional">（任意）</span></label>
              {participants.map(p => (
                <div key={p.id} className="participant-row">
                  <input type="text" value={p.name} placeholder="参加者名"
                    onChange={e => updateParticipantName(p.id, e.target.value)} />
                  <button className="btn-remove" onClick={() => removeParticipant(p.id)}>✕</button>
                </div>
              ))}
              <button className="btn-ghost" onClick={addParticipant}>＋ 参加者を追加</button>
            </div>

            {setupError && <p className="error">{setupError}</p>}

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
            <button className={`mic-btn ${micOn ? runState : 'off'}`} onClick={toggleMic}
              title={micOn ? 'マイクOFF' : 'マイクON'}>
              {micOn ? '🎙' : '🎙'}<span className="mic-label">{micOn ? 'ON' : 'OFF'}</span>
            </button>
            {hasAgenda ? (
              <>
                <div className="item-title">{items[currentItemIdx]?.title ?? '—'}</div>
                <div className={`timer ${timerOvertime ? 'overtime' : ''}`}>{timerDisplay}</div>
              </>
            ) : (
              <div className="item-title">{micOn ? '録音中' : 'マイクをONにしてください'}</div>
            )}
          </div>

          {/* Mic error banner */}
          {micError && (
            <div className="mic-error-banner">
              ⚠️ {micError}
              <button onClick={() => setMicError('')}>✕</button>
            </div>
          )}

          {/* Agenda nav (agenda mode only) */}
          {hasAgenda && items.length > 0 && (
            <div className="agenda-nav">
              {items.map((it, i) => (
                <button key={it.id}
                  className={`nav-item ${i === currentItemIdx ? 'active' : ''}`}
                  onClick={() => jumpToItem(i)}>
                  {i + 1}. {it.title}
                </button>
              ))}
            </div>
          )}

          {/* Mobile tab bar */}
          <div className="tab-bar">
            <button
              className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`}
              onClick={() => setActiveTab('transcript')}>
              🎙 文字起こし
            </button>
            <button
              className={`tab-btn ${activeTab === 'insights' ? 'active' : ''}`}
              onClick={() => setActiveTab('insights')}>
              📋 まとめ
              {(insights.decisions.length + insights.actions.length + insights.open_questions.length) > 0 && (
                <span className="badge">
                  {insights.decisions.length + insights.actions.length + insights.open_questions.length}
                </span>
              )}
            </button>
          </div>

          {/* Main area */}
          <div className="running-main">
            {/* Transcript panel */}
            <div className={`transcript-panel ${activeTab === 'transcript' ? 'tab-active' : 'tab-hidden'}`}>
              <div className="panel-header">
                <span className="speaker-label">話者:</span>
                <select className="speaker-select" value={currentSpeakerId}
                  onChange={e => setCurrentSpeakerId(e.target.value)}>
                  <option value="">（未選択）</option>
                  {store.current.participants.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="transcript-body">
                {transcriptLines.map(line => (
                  <p key={line.id} className={line.isInterim ? 'interim' : line.isInfo ? 'info-line' : ''}>
                    {!line.isInfo && line.speakerName && <span className="speaker-tag">{line.speakerName}: </span>}
                    {line.text}
                  </p>
                ))}
              </div>
            </div>

            {/* Insights panel */}
            <div className={`insights-panel ${activeTab === 'insights' ? 'tab-active' : 'tab-hidden'}`}>
              <div className="insight-section">
                <h3>✅ 決定事項</h3>
                <ul>{insights.decisions.length > 0
                  ? insights.decisions.map((d, i) => <li key={i}>{d}</li>)
                  : <li className="empty">まだありません</li>}
                </ul>
              </div>
              <div className="insight-section">
                <h3>📌 アクション</h3>
                <ul>{insights.actions.length > 0
                  ? insights.actions.map((a, i) => <li key={i}>{a.who}：{a.what}{a.due ? `（期限: ${a.due}）` : ''}</li>)
                  : <li className="empty">まだありません</li>}
                </ul>
              </div>
              <div className="insight-section grow">
                <h3>❓ 未解決の論点</h3>
                <ul>{insights.open_questions.length > 0
                  ? insights.open_questions.map((q, i) => <li key={i}>{q}</li>)
                  : <li className="empty">まだありません</li>}
                </ul>
              </div>
            </div>
          </div>

          {/* Hand-raised panel (agenda mode only) */}
          {hasAgenda && runState === 'hand_raised' && (
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
            {hasAgenda && (
              <button className="btn-ghost" onClick={handleNextItem}>⏭ 次の項目へ</button>
            )}
            <button className="btn-danger full-mobile" onClick={handleEndMeeting}>🔴 会議を終了する</button>
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
              <button className="btn-primary flex1" onClick={() => navigator.clipboard.writeText(minutes)}>
                📋 コピー
              </button>
              <button className="btn-ghost flex1" onClick={downloadMinutes}>⬇ DL</button>
            </div>
            <button className="btn-ghost muted" onClick={() => location.reload()}>
              ↩ 新しい会議を始める
            </button>
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
          --tap: 48px;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Hiragino Sans','Noto Sans JP',sans-serif; background: var(--bg); color: var(--text); font-size: 15px; line-height: 1.6; -webkit-text-size-adjust: 100%; }
        button { cursor: pointer; border: none; border-radius: 8px; padding: 12px 16px; min-height: var(--tap); font-size: 15px; font-family: inherit; transition: background .15s; -webkit-tap-highlight-color: transparent; }
        input, textarea, select { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 15px; padding: 10px 12px; width: 100%; outline: none; }
        input:focus, textarea:focus, select:focus { border-color: var(--primary); }
        select { min-height: var(--tap); }

        .browser-warning { background: var(--danger); color: #fff; padding: 12px 20px; text-align: center; font-weight: bold; font-size: 14px; }
        .accent { color: var(--primary); }
        .error { color: var(--danger); font-size: 13px; white-space: pre-wrap; }
        .hint { color: var(--text-muted); font-size: 12px; margin-top: 6px; }
        .optional { color: var(--text-muted); font-weight: normal; font-size: 11px; }

        /* Buttons */
        .btn-primary { background: var(--primary); color: #fff; font-size: 16px; font-weight: 600; width: 100%; }
        .btn-primary:hover:not(:disabled) { background: var(--primary-h); }
        .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
        .btn-ghost { background: var(--surface2); color: var(--text); }
        .btn-ghost:hover { background: var(--border); }
        .btn-ghost.muted { color: var(--text-muted); width: 100%; margin-top: 4px; }
        .btn-remove { background: var(--surface2); color: var(--text-muted); padding: 10px 14px; flex-shrink: 0; min-width: var(--tap); }
        .btn-remove:hover { background: var(--danger); color: #fff; }
        .btn-danger { background: var(--danger); color: #fff; font-weight: 600; }
        .btn-allow { background: var(--success); color: #fff; font-weight: 600; min-height: var(--tap); padding: 12px 20px; }
        .btn-dismiss { background: var(--surface2); color: var(--text-muted); min-height: var(--tap); }
        .flex1 { flex: 1; }

        /* Setup */
        .screen-setup { display: flex; flex-direction: column; align-items: center; padding: 24px 16px 40px; min-height: 100vh; }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; width: 100%; max-width: 640px; display: flex; flex-direction: column; gap: 20px; }
        .card h1 { font-size: 22px; }
        .card h2 { font-size: 18px; }
        .field label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
        .field textarea { height: 160px; resize: vertical; }
        .participant-row { display: flex; gap: 8px; margin-bottom: 6px; }

        /* Running */
        .screen-running { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; position: relative; }

        .running-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
        .mic-btn { display: flex; align-items: center; gap: 5px; border-radius: 20px; padding: 8px 14px; font-size: 15px; font-weight: 700; flex-shrink: 0; min-height: var(--tap); transition: background .2s, color .2s; }
        .mic-btn.off       { background: var(--surface2); color: var(--text-muted); }
        .mic-btn.off:hover { background: var(--success); color: #fff; }
        .mic-btn.listening  { background: var(--success); color: #fff; animation: pulse 1.5s infinite; }
        .mic-btn.evaluating { background: var(--warning); color: #fff; }
        .mic-btn.hand_raised { background: var(--orange); color: #fff; animation: pulse .5s infinite; }
        .mic-btn.speaking   { background: var(--primary); color: #fff; }
        .mic-label { font-size: 12px; letter-spacing: .05em; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.7} }
        .item-title { font-size: 15px; font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .timer { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--success); flex-shrink: 0; }
        .timer.overtime { color: var(--danger); }

        .agenda-nav { display: flex; gap: 6px; padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--border); overflow-x: auto; flex-shrink: 0; -webkit-overflow-scrolling: touch; }
        .nav-item { background: var(--surface2); color: var(--text-muted); white-space: nowrap; font-size: 12px; padding: 6px 12px; border-radius: 20px; min-height: 36px; }
        .nav-item.active { background: var(--primary); color: #fff; }

        /* Tab bar (visible on all sizes, prominent on mobile) */
        .tab-bar { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .tab-btn { flex: 1; background: transparent; color: var(--text-muted); border-radius: 0; border-bottom: 2px solid transparent; font-size: 14px; font-weight: 600; min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 6px; }
        .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); }
        .badge { background: var(--primary); color: #fff; font-size: 11px; font-weight: 700; border-radius: 10px; padding: 1px 6px; }

        .running-main { flex: 1; overflow: hidden; display: flex; }

        /* Desktop: side by side */
        .transcript-panel { flex: 1.5; display: flex; flex-direction: column; border-right: 1px solid var(--border); overflow: hidden; }
        .insights-panel { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; }

        .tab-hidden { display: none; }
        .tab-active { display: flex; flex: 1; flex-direction: column; }

        .panel-header { padding: 8px 14px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
        .speaker-label { font-weight: normal; font-size: 12px; }
        .speaker-select { font-size: 13px; padding: 6px 8px; width: auto; min-height: 36px; }
        .transcript-body { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 15px; line-height: 1.8; -webkit-overflow-scrolling: touch; }
        .transcript-body p { margin-bottom: 4px; }
        .speaker-tag { font-weight: 700; color: var(--primary-h); margin-right: 4px; }
        .interim { color: var(--text-muted); }
        .info-line { color: var(--success); font-size: 13px; font-style: italic; }

        .mic-error-banner { background: var(--danger); color: #fff; padding: 10px 16px; font-size: 13px; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .mic-error-banner button { background: transparent; color: #fff; padding: 2px 8px; font-size: 16px; min-height: unset; border: 1px solid rgba(255,255,255,.4); border-radius: 4px; }

        .insight-section { border-bottom: 1px solid var(--border); padding: 10px 14px; overflow-y: auto; }
        .insight-section.grow { flex: 1; border-bottom: none; }
        .insight-section h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); margin-bottom: 8px; }
        .insight-section ul { list-style: none; padding: 0; }
        .insight-section li { font-size: 13px; padding: 4px 0; border-bottom: 1px solid var(--border); }
        .insight-section li:last-child { border-bottom: none; }
        .insight-section li.empty { color: var(--text-muted); font-style: italic; }

        .hand-raised-panel { position: absolute; bottom: 70px; left: 50%; transform: translateX(-50%); background: var(--surface); border: 2px solid var(--orange); border-radius: 12px; padding: 16px 20px; width: calc(100% - 32px); max-width: 480px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.6); z-index: 100; }
        .hand-raised-header { font-weight: 700; color: var(--orange); font-size: 14px; }
        .hand-raised-msg { font-size: 15px; line-height: 1.6; }
        .hand-raised-footer { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
        .ttl-label { font-size: 12px; color: var(--text-muted); margin-right: auto; }

        .running-footer { padding: 10px 16px; background: var(--surface); border-top: 1px solid var(--border); display: flex; gap: 8px; justify-content: flex-end; flex-shrink: 0; }
        .full-mobile { flex: 1; }

        /* Ended */
        .screen-ended { display: flex; flex-direction: column; align-items: center; padding: 24px 16px 40px; min-height: 100vh; }
        .screen-ended .card { max-width: 760px; }
        .minutes-output { white-space: pre-wrap; font-size: 14px; line-height: 1.8; background: var(--surface2); border-radius: 8px; padding: 16px; min-height: 200px; max-height: 55vh; overflow-y: auto; font-family: inherit; -webkit-overflow-scrolling: touch; }
        .ended-actions { display: flex; gap: 8px; }

        /* Desktop: show both panels side by side always */
        @media (min-width: 640px) {
          .tab-bar { display: none; }
          .tab-hidden { display: flex !important; flex-direction: column; }
          .tab-active { display: flex; }
          .transcript-panel { display: flex !important; }
          .insights-panel { display: flex !important; width: 300px; }
          .running-footer .full-mobile { flex: unset; }
          .hand-raised-panel { width: auto; min-width: 340px; }
        }
      `}</style>
    </>
  );
}
