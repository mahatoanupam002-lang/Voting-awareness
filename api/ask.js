/**
 * api/ask.js — Claude-powered Q&A over The Bengal Reader's data
 *
 * POST /api/ask  { question: string }  → Server-Sent Events stream
 *
 * Loads relevant JSON data files based on keywords in the question,
 * then calls the Claude API and streams the answer back.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY — Claude API key
 */

export const config = { runtime: 'edge' };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DATA_BASE = 'https://voting-awareness-psi.vercel.app/data';

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadJSON(name) {
  try {
    const res = await fetch(`${DATA_BASE}/${name}`, { cf: { cacheTtl: 120 } });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

function summariseMlas(mlas) {
  if (!mlas) return '';
  const withCases = mlas.filter(m => m.cases > 0);
  return `MLA Criminal Records summary: ${mlas.length} total MLAs, ${withCases.length} have criminal cases. ` +
    `Top 5 by case count: ${withCases.sort((a,b)=>b.cases-a.cases).slice(0,5).map(m=>`${m.name} (${m.party}, ${m.cases} cases)`).join('; ')}.`;
}

function summariseConstituencies(data) {
  if (!data || !data.seats) return '';
  const byParty = {};
  data.seats.forEach(s => { byParty[s.party] = (byParty[s.party] || 0) + 1; });
  const sorted = Object.entries(byParty).sort((a,b)=>b[1]-a[1]);
  return `2026 West Bengal Assembly results: ${data.seats.length} seats counted. ` +
    sorted.map(([p,n]) => `${p}: ${n}`).join(', ') + '.';
}

function summarisePledges(pledges) {
  if (!pledges) return '';
  const byStatus = {};
  pledges.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  const list = pledges.map(p => `${p.id}. ${p.title} [${p.status}]`).join('\n');
  return `BJP's pre-election pledges (${pledges.length} total):\n${list}`;
}

function summariseCases(cases) {
  if (!cases) return '';
  return cases.map(c =>
    `Case: ${c.title}\nSummary: ${c.summary}\nLatest: ${(c.timeline||[]).slice(-2).map(t=>`${t.date}: ${t.event}`).join(' | ')}`
  ).join('\n\n');
}

function summariseAssets(assets) {
  if (!assets) return '';
  const top = (assets.mlas || assets).slice(0, 10);
  return 'Asset growth top 10 MLAs (2021→2026): ' + top.map(a => `${a.name}: ₹${a.assets2021}L → ₹${a.assets2026}L`).join('; ');
}

// ── Route question to relevant data ──────────────────────────────────────────
function selectData(question) {
  const q = question.toLowerCase();
  const needs = [];
  if (q.includes('mla') || q.includes('criminal') || q.includes('arrest') || q.includes('record')) needs.push('mlas');
  if (q.includes('corrupt') || q.includes('saradha') || q.includes('narada') || q.includes('ssc') || q.includes('case') || q.includes('ed') || q.includes('cbi')) needs.push('cases');
  if (q.includes('pledge') || q.includes('promise') || q.includes('deliver') || q.includes('100 day') || q.includes('manifesto') || q.includes('bjp')) needs.push('pledges');
  if (q.includes('seat') || q.includes('result') || q.includes('win') || q.includes('constituenc') || q.includes('election') || q.includes('margin')) needs.push('constituencies');
  if (q.includes('asset') || q.includes('wealth') || q.includes('rich') || q.includes('crore') || q.includes('lakh')) needs.push('assets');
  if (q.includes('bond') || q.includes('money') || q.includes('fund') || q.includes('donat')) needs.push('bonds');
  if (needs.length === 0) needs.push('cases', 'pledges', 'constituencies');
  return [...new Set(needs)];
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let question;
  try {
    const body = await req.json();
    question = (body.question || '').trim().slice(0, 500);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!question) {
    return new Response(JSON.stringify({ error: 'question is required' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Load relevant data in parallel
  const needs = selectData(question);
  const [mlas, cases, pledges, constituencies, assets] = await Promise.all([
    needs.includes('mlas') ? loadJSON('mlas.json') : Promise.resolve(null),
    needs.includes('cases') ? loadJSON('cases.json') : Promise.resolve(null),
    needs.includes('pledges') ? loadJSON('pledges.json') : Promise.resolve(null),
    needs.includes('constituencies') ? loadJSON('constituencies.json') : Promise.resolve(null),
    needs.includes('assets') ? loadJSON('assets.json') : Promise.resolve(null),
  ]);

  const context = [
    mlas && summariseMlas(Array.isArray(mlas) ? mlas : mlas.mlas || []),
    cases && summariseCases(Array.isArray(cases) ? cases : cases.cases || []),
    pledges && summarisePledges(Array.isArray(pledges) ? pledges : pledges.pledges || []),
    constituencies && summariseConstituencies(constituencies),
    assets && summariseAssets(assets),
  ].filter(Boolean).join('\n\n---\n\n');

  const systemPrompt = `You are a civic journalism assistant for The Bengal Reader, a non-partisan fact-based site covering West Bengal politics and the 2026 Assembly elections. You answer questions using only the data provided — no speculation. Be concise and factual. Use Indian English. If the data doesn't contain the answer, say so clearly. Never take a partisan position; report facts and let the reader draw conclusions.

Today's date: 2026-05-15.

DATA AVAILABLE:
${context}`;

  // Stream from Claude API
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      stream: true,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    return new Response(JSON.stringify({ error: 'Claude API error', detail: err }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Pass the SSE stream straight through to the client
  return new Response(claudeRes.body, {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
