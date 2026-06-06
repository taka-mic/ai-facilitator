// claude.js — Claude API calls (4 single-purpose functions)
// WARNING: API key is exposed client-side. For local verification only. Do NOT deploy.

import { store } from './agenda.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

async function callClaude(systemPrompt, userContent) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': store.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.content[0].text;
  // Strip markdown code fences safely
  const clean = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return clean;
}

// 7-1: Parse agenda text → structured agenda
export async function parseAgenda(rawText) {
  const system = `あなたは会議アジェンダ解析アシスタントです。
JSONのみ出力してください。前置き・コードフェンス・説明文は一切不要です。
出力形式:
{"purpose":"会議の目的（1〜2文）","items":[{"id":"1","title":"項目名","allotted_minutes":15}]}`;

  const user = `以下の会議アジェンダを解析してください:\n\n${rawText}`;
  const json = await callClaude(system, user);
  return JSON.parse(json);
}

// 7-2: Evaluate whether AI should intervene
export async function evaluateIntervention(ctx) {
  const system = `あなたは礼儀正しい会議ファシリテーターAIです。
会議の流れを分析し、介入すべきかを判断してください。
デフォルトは「介入しない（wants_to_speak: false）」です。
同じ趣旨の介入を繰り返さないでください。
JSONのみ出力してください。前置き・コードフェンス・説明文は一切不要です。
出力形式:
{"wants_to_speak":false,"type":"none","urgency":"low","spoken_message":"","note":""}
typeは "offtopic" | "time_over" | "agenda_progress" | "none" のいずれか。`;

  const user = `## 会議情報
目的: ${ctx.purpose}

## アジェンダ項目
${ctx.items.map((it, i) => `${i + 1}. ${it.title}（${it.allotted_minutes}分）${i === ctx.currentItemIndex ? ' ← 現在' : ''}`).join('\n')}

## 時間
経過: ${Math.floor(ctx.elapsed / 60)}分${ctx.elapsed % 60}秒
残り: ${Math.floor(ctx.remaining / 60)}分${ctx.remaining % 60}秒

## 直近の発言（最大3分）
${ctx.recentTranscript || '（なし）'}

## 直近の介入履歴（最大5件）
${ctx.interventionHistory.length > 0
  ? ctx.interventionHistory.slice(-5).map(r => `- [${r.type}] ${r.spoken_message} → ${r.outcome}`).join('\n')
  : '（なし）'}

介入すべきか判断してください。`;

  const json = await callClaude(system, user);
  return JSON.parse(json);
}

// 7-3: Extract decisions, actions, open questions
export async function extractInsights(ctx) {
  const system = `あなたは会議議事録アシスタントです。
発言から決定事項・アクション・未解決の論点を抽出してください。
JSONのみ出力してください。前置き・コードフェンス・説明文は一切不要です。
出力形式:
{"decisions":[],"actions":[{"who":"担当","what":"やること","due":"期限またはnull"}],"open_questions":[]}`;

  const user = `## 現在のアジェンダ項目
${ctx.currentItem?.title || '不明'}

## 直近の発言
${ctx.recentTranscript || '（なし）'}

決定事項・アクション・未解決の論点を抽出してください。`;

  const json = await callClaude(system, user);
  return JSON.parse(json);
}

// 7-4: Generate full meeting minutes
export async function generateMinutes(ctx) {
  const system = `あなたは会議議事録ライターです。
Markdown形式で議事録を作成してください。
構成: 目的・参加者・各アジェンダ項目の要約・決定事項・アクション一覧（表形式）・残課題`;

  const user = `## 会議目的
${ctx.purpose}

## 参加者
${ctx.participants.map(p => p.name).join('、') || '（未登録）'}

## アジェンダ
${ctx.items.map((it, i) => `${i + 1}. ${it.title}（${it.allotted_minutes}分）`).join('\n')}

## 全発言録
${ctx.fullTranscript || '（なし）'}

## 抽出済み情報
### 決定事項
${ctx.insights.decisions.map(d => `- ${d}`).join('\n') || '（なし）'}

### アクション
${ctx.insights.actions.map(a => `- ${a.who}：${a.what}（期限: ${a.due || '未定'}）`).join('\n') || '（なし）'}

### 未解決の論点
${ctx.insights.open_questions.map(q => `- ${q}`).join('\n') || '（なし）'}

議事録をMarkdownで作成してください。`;

  return await callClaude(system, user);
}
