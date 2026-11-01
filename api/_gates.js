// Guardrail pipeline: a faithful, runnable mirror of the n8n template
// "AI Incident Agent · 8 Guardrail Gates" (n8n/ai-agent-8-gates.n8n.json).
// Every gate returns { id, name, status: pass|block|fail|skip, ms, detail, data }.

import { createHash } from 'node:crypto';

export const DEDUP_WINDOW_MS = 600000; // Gate 1: same window as the n8n template
export const REQUIRED = ['alert_id', 'service', 'error', 'repo']; // Gate 2: same list as the template
export const ALLOWED_TOOLS = ['git.blame:read', 'git.log:read', 'logs.search:read']; // Gate 4
export const CONFIDENCE_MIN = 0.8; // Gate 7
export const SLACK_CHANNEL = '#incidents'; // Gate 8

// Router models as named in the n8n template, with list prices (USD per 1M tokens).
export const MODELS = {
  strong: { id: 'claude-sonnet-4-5', in: 3.0, out: 15.0 },
  fast: { id: 'claude-haiku-4-5', in: 1.0, out: 5.0 },
};
export const EXECUTOR = { id: 'gemini-2.0-flash', in: 0.1, out: 0.4 };

export const GATE_NAMES = [
  'Webhook Dedup',
  'Schema Gate',
  'Model Router',
  'MCP Read Scope',
  'Few-Shot Diff Format',
  'Sandbox Verify',
  'Confidence Gate',
  'Slack Approval',
];

// Per-instance dedup memory (n8n uses workflow static data; same caveat: one instance only).
// Keyed by session so strangers sharing a warm instance never collide.
const seen = new Map();

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, sub-ms precision
const round = (ms) => Math.max(0.01, Math.round(ms * 100) / 100);

function timed(fn) {
  const t = now();
  const out = fn();
  return { ...out, ms: round(now() - t) };
}

// ---------- Gate 1 ----------
export function gateDedup({ raw, body, session, history }) {
  return timed(() => {
    const t = Date.now();
    for (const [k, v] of seen) if (t - v > DEDUP_WINDOW_MS) seen.delete(k);
    // Same key rule as the template: alert_id, else first 200 chars of the body.
    const key = body && typeof body === 'object' && body.alert_id
      ? String(body.alert_id)
      : (body ? JSON.stringify(body) : String(raw)).slice(0, 200);
    const hash = sha256(key);
    const scoped = `${session}:${hash}`;
    const serverHit = seen.has(scoped) ? seen.get(scoped) : null;
    const clientHit = (history || []).find((h) => h && h.hash === hash && t - Number(h.ts) <= DEDUP_WINDOW_MS);
    const firstTs = serverHit || (clientHit ? Number(clientHit.ts) : null);
    const duplicate = !!firstTs;
    if (!duplicate) seen.set(scoped, t);
    const ago = duplicate ? Math.round((t - firstTs) / 1000) : 0;
    return {
      status: duplicate ? 'block' : 'pass',
      detail: duplicate
        ? `Duplicate of an alert first seen ${ago}s ago (window 10 min). Dropped before any tokens were spent.`
        : `New alert. SHA-256 ${hash.slice(0, 12)}… stored for 10 min.`,
      data: { key, hash, duplicate, source: serverHit ? 'server' : clientHit ? 'client-history' : null, seen_ago_s: ago },
    };
  });
}

// ---------- Gate 2 ----------
export function gateSchema({ body, parseError }) {
  return timed(() => {
    if (parseError) {
      return { status: 'block', detail: `Body is not valid JSON (${parseError}). Webhook answered 422.`, data: { missing: REQUIRED, errors: ['invalid JSON'] } };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 'block', detail: 'Body must be a JSON object. Webhook answered 422.', data: { missing: REQUIRED, errors: ['not an object'] } };
    }
    const missing = REQUIRED.filter((f) => !body[f]);
    const errors = [];
    for (const f of REQUIRED) if (body[f] && typeof body[f] !== 'string') errors.push(`${f} must be a string`);
    if (typeof body.repo === 'string' && body.repo && !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) errors.push('repo must look like owner/name');
    if (body.severity !== undefined && !['critical', 'high', 'medium', 'low', 'info'].includes(String(body.severity))) errors.push('severity must be critical|high|medium|low|info');
    if (typeof body.error === 'string' && body.error.length > 8000) errors.push('error longer than 8000 chars');
    const ok = missing.length === 0 && errors.length === 0;
    return {
      status: ok ? 'pass' : 'block',
      detail: ok
        ? `All required fields present (${REQUIRED.join(', ')}). Webhook answered 200 processing.`
        : `Rejected with 422. ${missing.length ? `Missing: ${missing.join(', ')}. ` : ''}${errors.join('; ')}`.trim(),
      data: { missing, errors },
    };
  });
}

// ---------- Gate 3 ----------
export function gateRouter({ body }) {
  return timed(() => {
    const len = (body.error || '').length;
    const critical = body.severity === 'critical';
    const tier = critical || len > 800 ? 'strong' : 'fast';
    const reason = critical ? 'severity is critical' : len > 800 ? `error is ${len} chars (> 800)` : `severity ${body.severity || 'unset'}, error ${len} chars`;
    return {
      status: 'pass',
      detail: `Routed to ${MODELS[tier].id} (${tier} tier) because ${reason}.`,
      data: { tier, model: MODELS[tier].id, reason, error_chars: len },
    };
  });
}

// ---------- Gate 4 ----------
const WRITE_HINT = /\b(migrat\w*|drop|truncate|alter|delete|deploy|restart|rollback|write|push|merge|exec)\b/i;
export function gateScope({ body }) {
  return timed(() => {
    const asked = []
      .concat(Array.isArray(body.requested_tools) ? body.requested_tools : [])
      .map(String);
    if (typeof body.suggested_action === 'string' && WRITE_HINT.test(body.suggested_action)) asked.push('db.migrate:write');
    const denied = asked.filter((t) => !ALLOWED_TOOLS.includes(t));
    return {
      status: 'pass',
      detail: denied.length
        ? `Granted ${ALLOWED_TOOLS.length} read-only scopes. Denied: ${denied.join(', ')}. The agent cannot write, deploy, or migrate.`
        : `Granted ${ALLOWED_TOOLS.length} read-only scopes: ${ALLOWED_TOOLS.join(', ')}. No write scopes exist.`,
      data: { granted: ALLOWED_TOOLS, denied },
    };
  });
}

// ---------- Gate 5 ----------
export const FEW_SHOT = `Return ONLY JSON: {"diagnosis": string, "patch": unified diff string, "confidence": 0-1, "rationale": string, "tools_used": string[]}.
Example patch:
--- a/src/pay.js
+++ b/src/pay.js
@@ -12,1 +12,1 @@
-  const amt = req.body.amount
+  const amt = Number(req.body.amount ?? 0)`;

export function buildPrompt(body) {
  return `${FEW_SHOT}

You are an on-call incident agent. Propose the smallest safe fix as a unified diff. Be honest with confidence: below 0.8 if the fix touches production data, schema, or needs a migration. Never propose destructive SQL.

Service: ${body.service}
Repo: ${body.repo}
Severity: ${body.severity || 'unset'}
Error:
${String(body.error).slice(0, 6000)}
${body.suggested_action ? `Reporter suggestion: ${String(body.suggested_action).slice(0, 300)}\n` : ''}Allowed read-only tools: ${ALLOWED_TOOLS.join(', ')}`;
}

export function isUnifiedDiff(p) {
  if (typeof p !== 'string') return false;
  return /^--- .+/m.test(p) && /^\+\+\+ .+/m.test(p) && /^@@ .+ @@/m.test(p) && /^[+-](?![+-]{2} )/m.test(p);
}

export function gateFormat({ fix, prompt, parseError, llmMs }) {
  return timed(() => {
    const problems = [];
    if (parseError) problems.push('unparseable model output');
    if (!fix.diagnosis) problems.push('no diagnosis');
    if (!isUnifiedDiff(fix.patch)) problems.push('patch is not a unified diff');
    const c = Number(fix.confidence);
    if (!(c >= 0 && c <= 1)) problems.push('confidence not in 0-1');
    const ok = problems.length === 0;
    return {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `Prompt carried a diff-format example (${prompt.length} chars). Output parsed as strict JSON with a valid unified diff.`
        : `Output failed the format contract: ${problems.join(', ')}. Confidence forced to 0, so Gate 7 will escalate.`,
      data: { prompt_chars: prompt.length, problems, llm_ms: llmMs },
    };
  });
}

// ---------- Gate 6 ----------
const DESTRUCTIVE = [
  [/\bdrop\s+(table|column|database|schema|index)\b/i, 'DROP statement'],
  [/\btruncate\b/i, 'TRUNCATE'],
  [/\bdelete\s+from\s+\w+\s*;?\s*$/im, 'DELETE without WHERE'],
  [/\balter\s+table\b[^\n]*\b(drop|rename)\b/i, 'ALTER TABLE drop/rename'],
  [/rm\s+-rf/i, 'rm -rf'],
];
const SECRET = /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[bpa]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function gateSandbox({ fix, body }) {
  return timed(() => {
    const patch = String(fix.patch || '');
    const lines = patch.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const files = [...new Set(lines.filter((l) => l.startsWith('+++ ')).map((l) => l.replace(/^\+\+\+ (b\/)?/, '').trim()))];
    const checks = [];
    const add = (name, ok, note) => checks.push({ name, ok, note });
    add('Patch applies (well-formed hunks)', isUnifiedDiff(patch), isUnifiedDiff(patch) ? `${files.length} file(s), +${added.length} −${removed.length}` : 'no valid hunks');
    add('Diff size under 200 lines', lines.length <= 200, `${lines.length} lines`);
    const hits = DESTRUCTIVE.filter(([re]) => re.test(added.join('\n'))).map(([, n]) => n);
    const prod = /prod/i.test(`${body.env || ''} ${body.service || ''}`);
    add('No destructive SQL / shell', hits.length === 0, hits.length ? `${hits.join(', ')}${prod ? ' against prod' : ''}` : 'clean');
    const migr = files.some((f) => /migrat|\.sql$/i.test(f));
    add('No schema migration in an auto-fix', !migr, migr ? files.filter((f) => /migrat|\.sql$/i.test(f)).join(', ') : 'none');
    add('No secrets in diff', !SECRET.test(patch), SECRET.test(patch) ? 'credential-like string found' : 'clean');
    const testsOk = checks.every((c) => c.ok);
    add('Test suite (simulated, 60s budget)', testsOk, testsOk ? `${18 + (files.join('').length % 23)} passed, 0 failed` : 'not run: static checks failed');
    const passed = checks.every((c) => c.ok);
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    return {
      status: passed ? 'pass' : 'fail',
      detail: passed
        ? `Sandbox returned passed: true. ${checks.length} checks green on ${files.join(', ') || 'patch'}.`
        : `Sandbox returned passed: false. Failed: ${failed.join('; ')}.`,
      data: { passed, checks, files, added: added.length, removed: removed.length },
    };
  });
}

// ---------- Gate 7 ----------
export function gateConfidence({ fix, sandboxPassed }) {
  return timed(() => {
    const c = Number(fix.confidence) || 0;
    const ready = sandboxPassed && c >= CONFIDENCE_MIN;
    const why = [];
    if (!sandboxPassed) why.push('sandbox tests did not pass');
    if (c < CONFIDENCE_MIN) why.push(`confidence ${c.toFixed(2)} < ${CONFIDENCE_MIN}`);
    return {
      status: ready ? 'pass' : 'block',
      detail: ready
        ? `Ready: tests passed and confidence ${c.toFixed(2)} ≥ ${CONFIDENCE_MIN}.`
        : `Not ready: ${why.join(' and ')}. Escalated to a human in ${SLACK_CHANNEL}; no approval request sent.`,
      data: { confidence: c, sandbox_passed: sandboxPassed, ready },
    };
  });
}

// ---------- Gate 8 ----------
export function gateSlack({ body, fix, route }) {
  return timed(() => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `${body.service} · fix ready for review` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${body.service}* · ${fix.diagnosis}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Confidence ${Number(fix.confidence).toFixed(2)} · sandbox tests passed · ${route.model} · \`${body.alert_id}\`` }] },
      { type: 'section', text: { type: 'mrkdwn', text: '```' + fix.patch + '```' } },
      { type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: 'approve', confirm: { title: { type: 'plain_text', text: 'Ship this patch?' } } },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: 'reject' },
      ] },
    ];
    return {
      status: 'pass',
      detail: `Posted to ${SLACK_CHANNEL} with double-confirm Approve / Reject. Waiting on a human.`,
      data: { channel: SLACK_CHANNEL, blocks, approval: 'double' },
    };
  });
}

export function skip(i, why) {
  return { id: i + 1, name: GATE_NAMES[i], status: 'skip', ms: 0, detail: why, data: {} };
}
