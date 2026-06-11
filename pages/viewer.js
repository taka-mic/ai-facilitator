// pages/viewer.js — Read-only real-time viewer for another device
import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';

export default function Viewer() {
  const [sessionId, setSessionId] = useState('');
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState('');

  const [transcriptLines, setTranscriptLines] = useState([]);
  const [insights, setInsights] = useState({ decisions: [], actions: [], open_questions: [] });
  const [handRaisedMsg, setHandRaisedMsg] = useState('');
  const [currentItem, setCurrentItem] = useState(null);
  const [timerDisplay, setTimerDisplay] = useState('');
  const [timerOvertime, setTimerOvertime] = useState(false);
  const [runState, setRunState] = useState('listening');
  const [ended, setEnded] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [activeTab, setActiveTab] = useState('transcript');

  const channelRef = useRef(null);
  const transcriptBottomRef = useRef(null);

  function handleJoin() {
    const id = sessionId.trim().toUpperCase();
    if (!id) { setJoinError('セッションIDを入力してください'); return; }
    setJoinError('');
    connectPusher(id);
  }

  function connectPusher(id) {
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!key || !cluster) {
      setJoinError('Pusher が設定されていません（NEXT_PUBLIC_PUSHER_KEY）');
      return;
    }

    import('pusher-js').then(({ default: PusherJs }) => {
      const pusher = new PusherJs(key, { cluster });
      const ch = pusher.subscribe(`session-${id}`);
      channelRef.current = ch;

      ch.bind('pusher:subscription_succeeded', () => setJoined(true));
      ch.bind('pusher:subscription_error', () => setJoinError('接続できませんでした。IDを確認してください。'));

      ch.bind('transcript', ({ lines }) => {
        setTranscriptLines(lines);
      });

      ch.bind('insights', (data) => {
        setInsights(data);
      });

      ch.bind('hand-raised', ({ message }) => {
        setHandRaisedMsg(message);
      });

      ch.bind('hand-lowered', () => {
        setHandRaisedMsg('');
      });

      ch.bind('agenda', ({ item, timerDisplay: td, overtime }) => {
        setCurrentItem(item);
        setTimerDisplay(td);
        setTimerOvertime(overtime);
      });

      ch.bind('state', ({ runState: rs }) => {
        setRunState(rs);
      });

      ch.bind('ended', ({ minutes: m }) => {
        setEnded(true);
        setMinutes(m);
      });

      // Joined optimistically — actual confirmation via subscription_succeeded
      setJoined(true);
    });
  }

  useEffect(() => {
    if (transcriptBottomRef.current) {
      transcriptBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcriptLines]);

  const stateLabel = { listening: '聴取中', evaluating: '考え中', hand_raised: '🙋 発言希望', speaking: '発話中' }[runState] || '';

  return (
    <>
      <Head>
        <title>AI ファシリテーター — ビューワー</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </Head>

      {!joined ? (
        <div className="join-screen">
          <div className="card">
            <h1>🖥️ <span className="accent">ビューワー</span></h1>
            <p className="hint">ホスト画面に表示されているセッションIDを入力してください</p>
            <input
              type="text"
              placeholder="例：AB12"
              value={sessionId}
              onChange={e => setSessionId(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              maxLength={6}
              className="session-input"
            />
            {joinError && <p className="error">{joinError}</p>}
            <button className="btn-primary" onClick={handleJoin}>参加する →</button>
          </div>
        </div>
      ) : ended ? (
        <div className="join-screen">
          <div className="card">
            <h1>📋 議事録</h1>
            <pre className="minutes-text">{minutes}</pre>
          </div>
        </div>
      ) : (
        <div className="viewer-screen">
          {/* Header */}
          <div className="viewer-header">
            <span className="session-badge">#{sessionId.trim().toUpperCase()}</span>
            <span className="state-badge">{stateLabel}</span>
            {currentItem && (
              <span className={`timer-badge ${timerOvertime ? 'overtime' : ''}`}>
                {currentItem.title}　{timerDisplay}
              </span>
            )}
          </div>

          {/* AI Hand raised */}
          {handRaisedMsg && (
            <div className="hand-banner">
              🙋 AI が発言を希望しています
              <div className="hand-msg">{handRaisedMsg}</div>
            </div>
          )}

          {/* Tab bar */}
          <div className="tab-bar">
            <button className={`tab-btn ${activeTab === 'transcript' ? 'active' : ''}`} onClick={() => setActiveTab('transcript')}>
              🎙 文字起こし
            </button>
            <button className={`tab-btn ${activeTab === 'insights' ? 'active' : ''}`} onClick={() => setActiveTab('insights')}>
              📋 まとめ
            </button>
          </div>

          {/* Transcript */}
          {activeTab === 'transcript' && (
            <div className="transcript-body">
              {transcriptLines.length === 0 && (
                <p className="hint-center">ホストが録音を開始すると表示されます</p>
              )}
              {transcriptLines.map(line => (
                <p key={line.id} className={line.isInterim ? 'interim' : line.isInfo ? 'info-line' : ''}>
                  {!line.isInfo && line.speakerName && <span className="speaker-tag">{line.speakerName}: </span>}
                  {line.text}
                </p>
              ))}
              <div ref={transcriptBottomRef} />
            </div>
          )}

          {/* Insights */}
          {activeTab === 'insights' && (
            <div className="insights-body">
              <div className="insight-section">
                <h3>✅ 決定事項</h3>
                <ul>{insights.decisions.length > 0
                  ? insights.decisions.map((d, i) => <li key={i}>{d}</li>)
                  : <li className="empty">まだありません</li>}
                </ul>
              </div>
              <div className="insight-section">
                <h3>🎯 アクション</h3>
                <ul>{insights.actions.length > 0
                  ? insights.actions.map((a, i) => (
                    <li key={i}>{a.who && <strong>{a.who}: </strong>}{a.what}{a.due ? `（${a.due}）` : ''}</li>
                  ))
                  : <li className="empty">まだありません</li>}
                </ul>
              </div>
              <div className="insight-section">
                <h3>❓ 未解決の論点</h3>
                <ul>{insights.open_questions.length > 0
                  ? insights.open_questions.map((q, i) => <li key={i}>{q}</li>)
                  : <li className="empty">まだありません</li>}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      <style jsx global>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #0f1117; --surface: #1a1d27; --surface2: #252836;
          --border: #2e3248; --text: #e8eaf6; --text-muted: #7b82a8;
          --primary: #5c6bc0; --primary-h: #7986cb;
          --success: #43a047; --warning: #ffa726; --danger: #ef5350;
          --tap: 44px;
        }
        html, body { height: 100%; background: var(--bg); color: var(--text); font-family: 'Hiragino Sans','Noto Sans JP',sans-serif; font-size: 15px; }
        button { cursor: pointer; border: none; border-radius: 8px; padding: 12px 16px; min-height: var(--tap); font-size: 15px; font-family: inherit; transition: background .15s; }
        input { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 15px; padding: 10px 12px; width: 100%; outline: none; }
        input:focus { border-color: var(--primary); }
        ul { list-style: none; padding: 0; }
        li { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 14px; line-height: 1.6; }
        li.empty { color: var(--text-muted); font-size: 13px; }

        .join-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 16px; }
        h1 { font-size: 22px; font-weight: 700; }
        .accent { color: var(--primary); }
        .hint { color: var(--text-muted); font-size: 13px; }
        .hint-center { color: var(--text-muted); font-size: 14px; text-align: center; margin-top: 40px; }
        .error { color: var(--danger); font-size: 13px; }
        .session-input { font-size: 28px; text-align: center; letter-spacing: .2em; font-weight: 700; }
        .btn-primary { background: var(--primary); color: #fff; font-size: 16px; font-weight: 600; width: 100%; }
        .btn-primary:hover { background: var(--primary-h); }

        .viewer-screen { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; }
        .viewer-header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; flex-shrink: 0; }
        .session-badge { background: var(--surface2); color: var(--text-muted); font-size: 12px; padding: 3px 8px; border-radius: 6px; font-weight: 700; }
        .state-badge { font-size: 13px; color: var(--text-muted); }
        .timer-badge { font-size: 13px; margin-left: auto; }
        .timer-badge.overtime { color: var(--danger); font-weight: 700; }

        .hand-banner { background: var(--warning); color: #000; padding: 10px 16px; font-size: 14px; font-weight: 600; flex-shrink: 0; }
        .hand-msg { font-size: 13px; font-weight: normal; margin-top: 4px; }

        .tab-bar { display: flex; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .tab-btn { flex: 1; background: transparent; color: var(--text-muted); border-radius: 0; border-bottom: 2px solid transparent; padding: 10px; font-size: 14px; }
        .tab-btn.active { color: var(--primary-h); border-bottom-color: var(--primary-h); }

        .transcript-body { flex: 1; overflow-y: auto; padding: 12px 16px; font-size: 15px; line-height: 1.8; -webkit-overflow-scrolling: touch; }
        .transcript-body p { margin-bottom: 4px; }
        .interim { color: var(--text-muted); }
        .info-line { color: var(--success); font-size: 13px; font-style: italic; }
        .speaker-tag { font-weight: 700; color: var(--primary-h); margin-right: 4px; }

        .insights-body { flex: 1; overflow-y: auto; padding: 0; }
        .insight-section { border-bottom: 1px solid var(--border); padding: 12px 16px; }
        .insight-section h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); margin-bottom: 8px; }

        .minutes-text { white-space: pre-wrap; font-size: 14px; line-height: 1.8; color: var(--text); font-family: inherit; }
      `}</style>
    </>
  );
}
