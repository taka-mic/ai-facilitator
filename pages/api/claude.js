// pages/api/claude.js — server-side proxy for all Claude calls
// API key stays server-side; never exposed to the browser.

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-8';

function stripFences(text) {
  return text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
}

async function callClaude(system, user, maxTokens = 1024) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content[0].text;
}

// ── 7-1 ──────────────────────────────────────────────────────────────────────
async function parseAgenda(body) {
  const system = `あなたは会議アジェンダ解析アシスタントです。
JSONのみ出力してください。前置き・コードフェンス・説明文は一切不要です。
出力形式: {"purpose":"会議の目的（1〜2文）","items":[{"id":"1","title":"項目名","allotted_minutes":15}]}`;
  const raw = await callClaude(system, `以下の会議アジェンダを解析してください:\n\n${body.rawText}`);
  return JSON.parse(stripFences(raw));
}

// ── 7-2 ──────────────────────────────────────────────────────────────────────
async function evaluateIntervention(body) {
  const { ctx } = body;
  const system = `あなたは礼儀正しい会議ファシリテーターAIです。
介入すべきかを判断してください。デフォルトは介入しない（wants_to_speak: false）。
同じ趣旨の介入を繰り返さないでください。
JSONのみ出力してください。前置き・コードフェンス・説明文は一切不要です。
出力形式: {"wants_to_speak":false,"type":"none","urgency":"low","spoken_message":"","note":""}
typeは "offtopic" | "time_over" | "agenda_progress" | "none" のいずれか。`;

  const user = `## 会議情報
目的: ${ctx.purpose}

## アジェンダ項目
${ctx.items.map((it, i) => `${i + 1}. ${it.title}（${it.allotted_minutes}分）${i === ctx.currentItemIndex ? ' ← 現在' : ''}`).join('\n')}

## 時間
経過: ${Math.floor(ctx.elapsed / 60)}分${ctx.elapsed % 60}秒 / 残り: ${Math.floor(ctx.remaining / 60)}分${ctx.remaining % 60}秒

## 直近の発言（最大3分）
${ctx.recentTranscript || '（なし）'}

## 直近の介入履歴（最大5件）
${ctx.interventionHistory.length > 0
  ? ctx.interventionHistory.slice(-5).map(r => `- [${r.type}] ${r.spoken_message} → ${r.outcome}`).join('\n')
  : '（なし）'}`;

  const raw = await callClaude(system, user);
  return JSON.parse(stripFences(raw));
}

// ── 7-3 ──────────────────────────────────────────────────────────────────────
async function extractInsights(body) {
  const { ctx } = body;
  const system = `あなたは会議議事録アシスタントです。
発言から決定事項・アクション・未解決の論点を抽出してください。
JSONのみ出力してください。前置き・コードフェンス・説明文は一切不要です。
出力形式: {"decisions":[],"actions":[{"who":"担当","what":"やること","due":"期限またはnull"}],"open_questions":[]}`;

  const user = `## 現在のアジェンダ項目\n${ctx.currentItemTitle || '不明'}\n\n## 直近の発言\n${ctx.recentTranscript || '（なし）'}`;
  const raw = await callClaude(system, user);
  return JSON.parse(stripFences(raw));
}

// ── 7-4 ──────────────────────────────────────────────────────────────────────
async function generateMinutes(body) {
  const { ctx } = body;
  const system = `あなたは会議議事録ライターです。Markdown形式で議事録を作成してください。
構成: 目的・参加者・各アジェンダ項目の要約・決定事項・アクション一覧（表形式）・残課題`;

  const user = `## 会議目的\n${ctx.purpose}

## 参加者\n${ctx.participants.join('、') || '（未登録）'}

## アジェンダ\n${ctx.items.map((it, i) => `${i + 1}. ${it.title}（${it.allotted_minutes}分）`).join('\n')}

## 全発言録\n${ctx.fullTranscript || '（なし）'}

## 抽出済み情報
### 決定事項\n${ctx.insights.decisions.map(d => `- ${d}`).join('\n') || '（なし）'}

### アクション\n${ctx.insights.actions.map(a => `- ${a.who}：${a.what}（期限: ${a.due || '未定'}）`).join('\n') || '（なし）'}

### 未解決の論点\n${ctx.insights.open_questions.map(q => `- ${q}`).join('\n') || '（なし）'}`;

  return await callClaude(system, user, 4096);
}

// ── Router ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { type, ...body } = req.body;
  try {
    let result;
    if (type === 'parse-agenda')        result = await parseAgenda(body);
    else if (type === 'evaluate')       result = await evaluateIntervention(body);
    else if (type === 'extract')        result = await extractInsights(body);
    else if (type === 'minutes')        result = await generateMinutes(body);
    else return res.status(400).json({ error: 'unknown type' });
    res.status(200).json(result);
  } catch (e) {
    console.error('[claude api]', e);
    res.status(500).json({ error: e.message });
  }
}
