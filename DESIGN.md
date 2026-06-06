# 会議ファシリテーター — 設計提案

> Phase 1 実装前の承認用ドキュメント。承認後、このファイルは削除して実装に移行します。

---

## 1. 状態機械

```
┌─────────────────────────────────────────────────────────────┐
│  IDLE  ──→  SETUP  ──→  RUNNING  ──→  ENDED                │
│                              │                               │
│              RUNNING サブ状態（1系統目：介入ループ）         │
│              ┌───────────────────────────────────┐          │
│              │  LISTENING                        │          │
│              │    ↓ トリガー発火（無音1.5s /      │          │
│              │       20s 定期 / タイマー超過）    │          │
│              │  EVALUATING  ← Claude 7-2 呼び出し│          │
│              │    ↓ wants_to_speak=false          │          │
│              │  LISTENING（戻る）                 │          │
│              │    ↓ wants_to_speak=true           │          │
│              │  HAND_RAISED（TTL=90s）            │          │
│              │    ↓ 許可ボタン押下                │          │
│              │  SPEAKING  ← TTS 発話              │          │
│              │    ↓ 発話終了                      │          │
│              │  LISTENING（戻る）                 │          │
│              │                                   │          │
│              │  HAND_RAISED で TTL 切れ           │          │
│              │    → 静かに LISTENING に戻る        │          │
│              └───────────────────────────────────┘          │
│                                                              │
│              2系統目：抽出タイマー（完全独立）               │
│              RUNNING 中、1分ごと or 項目切替時に             │
│              Claude 7-3 を呼ぶ（介入ループと無関係）         │
└─────────────────────────────────────────────────────────────┘
```

### 状態遷移一覧

| From | To | トリガー |
|---|---|---|
| IDLE | SETUP | ページロード完了 |
| SETUP | RUNNING | 「会議開始」ボタン（アジェンダ解析 7-1 の完了後） |
| RUNNING/LISTENING | RUNNING/EVALUATING | 無音 ≧1.5s / 20s 定期 / 時間超過イベント |
| RUNNING/EVALUATING | RUNNING/HAND_RAISED | Claude → wants_to_speak=true |
| RUNNING/EVALUATING | RUNNING/LISTENING | Claude → wants_to_speak=false |
| RUNNING/HAND_RAISED | RUNNING/SPEAKING | 議長が「許可」ボタン押下 |
| RUNNING/HAND_RAISED | RUNNING/LISTENING | TTL(90s)切れ or 「却下」ボタン |
| RUNNING/SPEAKING | RUNNING/LISTENING | TTS 発話終了イベント |
| RUNNING | ENDED | 「会議終了」ボタン → 議事録生成 7-4 完了後 |

---

## 2. ファイル構成

```
ai-facilitator/
├── index.html       # 全画面のマークアップ＋CSS（3画面をhidden/visible切替）
├── app.js           # 状態機械・メインループ・イベント接続
├── claude.js        # Claude API 呼び出し 4種（7-1〜7-4）
├── speech.js        # STT/TTS ラッパー（Phase 2 で差し替え可能なインターフェース）
└── agenda.js        # アジェンダ・名簿・抽出データのストア
```

### 各ファイルの責務

#### `index.html`
- CSS（カラー変数・レイアウト）をインラインで持つ
- 3画面（`#screen-setup` / `#screen-running` / `#screen-ended`）を `display:none` 切替
- `<script type="module">` で各 .js を読み込む

#### `app.js`
- `AppState` オブジェクトで現在の状態を一元管理
- 介入ループ（`scheduleEvaluation()`）
- 抽出タイマー（`scheduleExtraction()`）— 介入ループとは別の `setInterval`
- UI 更新関数（`renderState()`）
- アジェンダタイマー（`AgendaTimer`）— 項目ごとの経過・残り時間を管理

#### `claude.js`
```js
// 外部公開 API（4関数）
export async function parseAgenda(rawText)       // 7-1
export async function evaluateIntervention(ctx)  // 7-2
export async function extractInsights(ctx)       // 7-3
export async function generateMinutes(ctx)       // 7-4
// 共通: JSON フェンス除去 → JSON.parse → バリデーション
```

#### `speech.js`
```js
// STT（差し替え可能インターフェース）
export function startSTT(onChunk)   // onChunk: ({text, isFinal, speaker?}) => void
export function stopSTT()

// TTS
export function speak(text, onEnd)
export function cancelSpeak()
```
Phase 2 では `startSTT` の中身を Deepgram/AssemblyAI に差し替えるだけでよい。
`speaker` フィールドは Phase 1 では常に `null`（手動タグで上書き）。

#### `agenda.js`
```js
// ストア（inmemory、getter/setter）
export const store = {
  apiKey: '',
  purpose: '',
  items: [],           // AgendaItem[]
  participants: [],    // Participant[]
  currentItemIndex: 0,
  transcript: [],      // TranscriptChunk[]
  interventionHistory: [], // InterventionRecord[]
  insights: { decisions:[], actions:[], open_questions:[] },
  minutes: '',
}
```

---

## 3. データモデル

```ts
// アジェンダ項目
interface AgendaItem {
  id: string
  title: string
  allotted_minutes: number
  elapsed_seconds: number   // app.js のタイマーが更新
}

// 参加者（Phase 1 は手動登録）
interface Participant {
  id: string
  name: string
  label?: string  // Phase 2: "Speaker 0" 等のdiarizationラベル
}

// 文字起こしチャンク
interface TranscriptChunk {
  at: number          // Date.now()
  text: string
  isFinal: boolean
  speaker: string | null   // Participant.id or null
  agendaItemId: string
}

// 介入判定結果（履歴として保持）
interface InterventionRecord {
  at: number
  type: 'offtopic' | 'time_over' | 'agenda_progress' | 'none'
  urgency: 'low' | 'medium' | 'high'
  spoken_message: string
  note: string
  outcome: 'spoken' | 'dismissed' | 'expired'  // 発話/却下/TTL切れ
}

// 抽出結果（最新のみ保持・累積）
interface Insights {
  decisions: string[]
  actions: ActionItem[]
  open_questions: string[]
}

interface ActionItem {
  who: string
  what: string
  due: string | null
}
```

---

## 4. 各画面のラフ

### 画面 1：セットアップ（SETUP）

```
┌──────────────────────────────────────────────┐
│  🤝 AI ファシリテーター                        │
│  ─────────────────────────────────────────   │
│  Claude API キー  [__________________________]│
│                                              │
│  会議の目的・アジェンダ                        │
│  ┌──────────────────────────────────────┐   │
│  │ （ここに貼り付け or テキスト入力）    │   │
│  │                                      │   │
│  └──────────────────────────────────────┘   │
│  ［ファイルを選択］                           │
│                                              │
│  参加者                                      │
│  ┌──────────────────────────────────┐       │
│  │ 田中 太郎  [✕]                   │       │
│  │ 鈴木 花子  [✕]                   │       │
│  └──────────────────────────────────┘       │
│  ［+ 参加者を追加］                           │
│                                              │
│            ［ 会議を開始 → ］                 │
└──────────────────────────────────────────────┘
```

- API キーは `localStorage` に保存（再入力不要）
- 「会議を開始」押下 → Claude 7-1（アジェンダ解析）→ 成功したら RUNNING に遷移
- 解析中はスピナー表示

---

### 画面 2：進行（RUNNING）

```
┌──────────────────────────────────────────────────────┐
│  📋 3/5  予算承認                      残り 08:32     │
│  ──────────────────────────────────────────────────  │
│  [① 開会] [② 前回確認] [③ 予算承認 ◀] [④ ...] [⑤ ...]│
│                                                      │
│  ┌── 文字起こし（ライブ） ──────────────────────┐   │
│  │ ...田中: 今期の赤字については先ほど説明した   │   │
│  │ 通りで、来期の予算案ですが──                 │   │
│  │ ▌（入力中）                                  │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  現在の話者: ［田中 太郎 ▼］                         │
│                                                      │
│  ┌── 決定事項・アクション・論点 ───────────────┐   │
│  │ ✅ 決定: 前回議事録を承認                    │   │
│  │ 📌 TODO: 鈴木→来期予算書を金曜までに配布     │   │
│  │ ❓ 論点: コスト削減の具体策が未決定          │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ╔══════════════════════════════════════════════╗   │
│  ║  🤚 AI が発言を希望しています               ║   │
│  ║  「時間が少なくなっています。次の項目に      ║   │
│  ║    移りますか？」                           ║   │
│  ║  ［ 許可 ✓ ］  ［ 却下 ✕ ］               ║   │
│  ╚══════════════════════════════════════════════╝   │
│                   （挙手時のみ表示）                  │
│                                                      │
│  ─────────────────────────────────────────────────  │
│  ［ ⏭ 次の項目へ ］        ［ 🔴 会議を終了する ］   │
└──────────────────────────────────────────────────────┘
```

**状態別 UI 変化**

| 状態 | 挙手パネル | マイクアイコン |
|---|---|---|
| LISTENING | 非表示 | 緑点滅 |
| EVALUATING | 非表示 | 黄色 |
| HAND_RAISED | **表示**（TTL カウントダウン付き） | 緑点滅 |
| SPEAKING | 非表示（TTSで喋っている） | 青 |

---

### 画面 3：終了（ENDED）

```
┌──────────────────────────────────────────────┐
│  📝 議事録                                    │
│  ─────────────────────────────────────────   │
│  # 予算審議会議 議事録                        │
│  日時: 2026-06-06  参加: 田中・鈴木・...      │
│                                              │
│  ## 目的                                     │
│  来期予算案の審議・承認                       │
│                                              │
│  ## アジェンダと要約                         │
│  ### 1. 開会（3分）                          │
│  ...                                         │
│                                              │
│  ## 決定事項                                  │
│  - 前回議事録を承認                           │
│                                              │
│  ## アクション                               │
│  | 担当 | 内容 | 期限 |                      │
│  |------|------|------|                      │
│  | 鈴木 | 予算書配布 | 金曜 |                │
│                                              │
│  ─────────────────────────────────────────  │
│  ［ 📋 コピー ］  ［ ⬇ .md ダウンロード ］    │
│  ［ ↩ 新しい会議を始める ］                   │
└──────────────────────────────────────────────┘
```

---

## 5. 介入ループの詳細フロー

```
app.js 内の scheduleEvaluation()
│
├─ トリガー A: SpeechRecognition の onresult で
│   isFinal=true かつ 前回 final から 1.5s 無音 → 即時発火
│
├─ トリガー B: setInterval(20000) → 20s ごとに発火
│
└─ トリガー C: AgendaTimer → 項目の allotted_minutes を超えたら発火

発火時:
  if (state === 'EVALUATING' || state === 'HAND_RAISED') return  // 多重呼び出し防止

  state → EVALUATING
  context = {
    purpose, items, currentItemIndex,
    elapsed, remaining,
    recentTranscript,   // 直近3分分のテキスト
    interventionHistory // 直近5件のoutcome付き
  }
  result = await evaluateIntervention(context)

  if result.wants_to_speak:
    state → HAND_RAISED
    store.pendingIntervention = result
    playChime()
    startTTL(90s, () => { state → LISTENING; store.pendingIntervention = null })
  else:
    state → LISTENING
```

---

## 6. 抽出タイマー（別系統）

```
app.js 内の scheduleExtraction()

setInterval(60000) → 1分ごと
+ 項目切替時に即時実行

context = { recentTranscript, currentItem }
result = await extractInsights(context)

// 累積マージ（重複除去）
store.insights.decisions = deduplicate([...store.insights.decisions, ...result.decisions])
store.insights.actions   = mergeActions(store.insights.actions, result.actions)
store.insights.open_questions = deduplicate([...store.insights.open_questions, ...result.open_questions])

renderInsightsPanel()
```

---

## 7. STT インターフェース（Phase 2 差し替えポイント）

```js
// speech.js が外部に公開するイベントの形
interface TranscriptChunkEvent {
  text: string
  isFinal: boolean
  speaker: string | null  // Phase 1: null / Phase 2: "Speaker 0" 等
}

// Phase 1 実装（Web Speech API）
startSTT(onChunk: (e: TranscriptChunkEvent) => void): void

// Phase 2 で差し替え（Deepgram/AssemblyAI）
// 同じ onChunk シグネチャを実装するだけ
```

---

## 8. 未解決の設計判断（実装前に確認したい点）

1. **アジェンダ解析の失敗時**: Claude が構造化に失敗した場合、フリーテキストのままで会議を続行できるか、それともリトライを求めるか？
   - 提案: リトライ UI を表示し、手動で項目数と時間を入力できるフォールバックを持つ。

2. **EVALUATING 中の新たなトリガー**: 評価中に無音トリガーが来た場合、無視（多重呼び出し防止）でよいか？
   - 提案: はい、`if (state !== 'LISTENING') return` でガード。

3. **抽出結果の累積戦略**: 同じ決定事項が複数回抽出された場合の重複除去をどこまで厳密にするか？
   - 提案: Phase 1 は単純な文字列一致で重複除去、精度はPhase 2 で改善。

4. **会議終了時の確認**: 「会議を終了する」ボタンを誤タップした場合の確認ダイアログは必要か？
   - 提案: あり（「本当に終了しますか？」）。

---

*このファイルは設計確認用。承認後に `DESIGN.md` を削除して実装に進みます。*
