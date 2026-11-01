// POST /api/run — execute the 8 guardrail gates on one incident webhook.
import {
  GATE_NAMES, MODELS, EXECUTOR, gateDedup, gateSchema, gateRouter, gateScope,
  buildPrompt, gateFormat, gateSandbox, gateConfidence, gateSlack, skip, SLACK_CHANNEL,
} from './_gates.js';
import { demoFix } from './_demo.js';

export const MAX_RAW = 16000;
const MAX_HISTORY = 50;
export const RATE = { windowMs: 60000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 30 };
const hits = new Map();

function limited(ip) {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter((x) => t - x < RATE.windowMs);
  arr.push(t);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE.max;
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64000) throw new Error('too large');
  }
  return JSON.parse(data || '{}');
}

const est = (s) => Math.ceil(String(s).length / 4);
const usd = (m, i, o) => (i * m.in + o * m.out) / 1e6;

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.MODEL_TIMEOUT_MS) || 20000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1500 },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    let out = null;
    let parseError = null;
    try { out = JSON.parse(text); } catch (e) { parseError = 'Unparseable model output'; }
    return {
      out, parseError,
      tokens_in: j?.usageMetadata?.promptTokenCount ?? est(prompt),
      tokens_out: j?.usageMetadata?.candidatesTokenCount ?? est(text),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFix(o) {
  o = o && typeof o === 'object' ? o : {};
  return {
    diagnosis: String(o.diagnosis || '').slice(0, 600),
    patch: String(o.patch || '').slice(0, 8000),
    confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)),
    rationale: String(o.rationale || '').slice(0, 800),
    tools_used: Array.isArray(o.tools_used) ? o.tools_used.map(String).slice(0, 10) : [],
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  if (limited(ip)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE.windowMs / 1000)));
    return res.status(429).json({ error: 'Too many runs. Try again in a minute.' });
  }

  let input;
  try { input = await readBody(req); } catch { return res.status(400).json({ error: 'Request must be JSON.' }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'Request body must be a JSON object.' });
  if (input.raw !== undefined && typeof input.raw !== 'string') return res.status(400).json({ error: '`raw` must be a string.' });

  const raw = typeof input.raw === 'string' ? input.raw : JSON.stringify(input.payload ?? {});
  if (raw.length > MAX_RAW) return res.status(413).json({ error: `Payload over ${MAX_RAW} characters.` });
  const session = String(input.session || 'anon').replace(/[^\w-]/g, '').slice(0, 40) || 'anon';
  const history = Array.isArray(input.history) ? input.history.slice(-MAX_HISTORY) : [];

  let body = null;
  let parseError = null;
  try { body = JSON.parse(raw); } catch (e) { parseError = String(e.message).slice(0, 80); }

  const t0 = Date.now();
  const gates = [];
  const push = (i, g) => gates.push({ id: i + 1, name: GATE_NAMES[i], ...g });
  const finish = (extra) => res.status(200).json({
    mode: extra.mode || 'demo',
    executor: extra.mode === 'live' ? EXECUTOR.id : 'templated (demo)',
    gates,
    total_ms: Date.now() - t0,
    ...extra,
  });

  // Gate 1 · Dedup
  const g1 = gateDedup({ raw, body: parseError ? null : body, session, history });
  push(0, g1);
  if (g1.status === 'block') {
    for (let i = 1; i < 8; i++) gates.push(skip(i, 'Not reached: duplicate dropped at Gate 1.'));
    return finish({ outcome: 'duplicate', hash: g1.data.hash, webhook: { status: 200, body: { status: 'accepted' } }, cost: { usd: 0, tokens_in: 0, tokens_out: 0, model: null, baseline_usd: 0 } });
  }

  // Gate 2 · Schema
  const g2 = gateSchema({ body, parseError });
  push(1, g2);
  if (g2.status === 'block') {
    for (let i = 2; i < 8; i++) gates.push(skip(i, 'Not reached: payload rejected at Gate 2.'));
    return finish({ outcome: 'rejected', hash: g1.data.hash, webhook: { status: 422, body: { status: 'rejected', missing: g2.data.missing } }, cost: { usd: 0, tokens_in: 0, tokens_out: 0, model: null, baseline_usd: 0 } });
  }

  // Gates 3–5
  const g3 = gateRouter({ body });
  push(2, g3);
  const g4 = gateScope({ body });
  push(3, g4);
  const prompt = buildPrompt(body);

  const tl = Date.now();
  const live = await callGemini(prompt);
  let mode = 'demo';
  let fix;
  let parseErr = null;
  let tokens_in;
  let tokens_out;
  if (live) {
    mode = 'live';
    fix = normalizeFix(live.out);
    parseErr = live.parseError;
    tokens_in = live.tokens_in;
    tokens_out = live.tokens_out;
  } else {
    fix = normalizeFix(demoFix(body));
    tokens_in = est(prompt);
    tokens_out = est(JSON.stringify(fix));
  }
  const llmMs = mode === 'live' ? Date.now() - tl : 0;
  if (parseErr || !fix.patch) fix.confidence = 0;

  const g5 = gateFormat({ fix, prompt, parseError: parseErr, llmMs });
  if (g5.status === 'fail') fix.confidence = 0;
  push(4, g5);

  // Unauthorized tool use by the model is stripped and noted.
  const offScope = fix.tools_used.filter((t) => !g4.data.granted.includes(t));
  if (offScope.length) {
    g4.data.denied = [...new Set([...g4.data.denied, ...offScope])];
    gates[3].detail += ` Model asked for ${offScope.join(', ')}; refused.`;
  }

  const g6 = gateSandbox({ fix, body });
  push(5, g6);
  const g7 = gateConfidence({ fix, sandboxPassed: g6.data.passed });
  push(6, g7);

  const model = MODELS[g3.data.tier];
  const cost = {
    model: model.id,
    tokens_in, tokens_out,
    usd: usd(model, tokens_in, tokens_out),
    baseline_usd: usd(MODELS.strong, tokens_in, tokens_out),
    executor_usd: mode === 'live' ? usd(EXECUTOR, tokens_in, tokens_out) : 0,
  };
  const route = g3.data;
  const common = { mode, hash: g1.data.hash, route, fix, cost, llm: { ms: llmMs, tokens_in, tokens_out }, webhook: { status: 200, body: { status: 'processing' } } };

  if (g7.status === 'block') {
    gates.push(skip(7, 'Not reached: escalated to a human instead of asking for approval.'));
    return finish({ ...common, outcome: 'escalated', slack: { channel: SLACK_CHANNEL, text: `${body.service}: agent not confident or sandbox failed. Needs a human.\n${fix.diagnosis}` } });
  }

  const g8 = gateSlack({ body, fix, route });
  push(7, g8);
  return finish({ ...common, outcome: 'awaiting_approval', slack: { channel: g8.data.channel, blocks: g8.data.blocks } });
}
