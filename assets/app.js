// Agent Guardrails Playground · client
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WINDOW = 600000;
const RUN_TIMEOUT_MS = 30000;
const LS = { session: 'agp.session', history: 'agp.history', audit: 'agp.audit' };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const ICON = {
  ok: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

const GATES = [
  ['Webhook dedup', 'SHA-256 of alert_id, 10-minute window'],
  ['Schema gate', 'alert_id, service, error, repo, else 422'],
  ['Model router', 'Critical or > 800 chars → strong model'],
  ['MCP read scope', 'Read-only tool allowlist, no write scopes'],
  ['Few-shot diff format', 'Strict JSON with a unified-diff patch'],
  ['Sandbox verify', 'Apply patch, static checks, run tests'],
  ['Confidence gate', 'Tests passed and confidence ≥ 0.80'],
  ['Slack approval', 'Double confirm in #incidents'],
];

const LONG_TRACE = [
  'TypeError: window is not defined',
  '    at CartBadge (src/components/CartBadge.jsx:9:18)',
  '    at renderWithHooks (node_modules/react-dom/cjs/react-dom-server.node.development.js:5662:16)',
  '    at renderIndeterminateComponent (node_modules/react-dom/cjs/react-dom-server.node.development.js:5735:15)',
  '    at renderElement (node_modules/react-dom/cjs/react-dom-server.node.development.js:5950:7)',
  '    at renderNodeDestructiveImpl (node_modules/react-dom/cjs/react-dom-server.node.development.js:6108:11)',
  '    at renderNodeDestructive (node_modules/react-dom/cjs/react-dom-server.node.development.js:6080:14)',
  '    at renderNode (node_modules/react-dom/cjs/react-dom-server.node.development.js:6263:12)',
  '    at renderChildrenArray (node_modules/react-dom/cjs/react-dom-server.node.development.js:6215:7)',
  '    at renderNodeDestructiveImpl (node_modules/react-dom/cjs/react-dom-server.node.development.js:6145:7)',
  '    at Header (src/components/Header.jsx:22:7)',
  '    at retryTask (node_modules/react-dom/cjs/react-dom-server.node.development.js:6615:7)',
  'Error occurred prerendering page "/cart". 1,284 SSR failures in the last 5 min; cart page served as blank shell.',
].join('\n');

const NULL_FIX = {
  alert_id: 'inc-1042',
  service: 'payments-api',
  severity: 'high',
  repo: 'acme/payments',
  error: "TypeError: Cannot read properties of undefined (reading 'amount') at src/pay.js:12",
};

const PRESETS = [
  { id: 'null', label: 'Null-pointer fix', tone: 'ok', expect: 'Passes all 8', payload: NULL_FIX },
  { id: 'dup', label: 'Duplicate alert', tone: 'warn', expect: 'Blocked at gate 1', storm: true, payload: NULL_FIX },
  { id: 'bad', label: 'Malformed payload', tone: 'bad', expect: '422 at gate 2', payload: { alert_id: 'inc-1077', service: 'search-api', severity: 'urgent!!', message: 'search is down???' } },
  { id: 'db', label: 'Risky prod DB change', tone: 'warn', expect: 'Escalated at gate 7', payload: {
    alert_id: 'inc-2207', service: 'orders-db', env: 'prod', severity: 'critical', repo: 'acme/orders',
    error: 'SQLSTATE 40P01 deadlock detected on table orders; lock wait timeout on legacy_status backfill. 37% of checkout writes failing.',
    suggested_action: 'run a migration to drop legacy_status on prod',
  } },
  { id: 'ssr', label: 'Long SSR stack trace', tone: 'ok', expect: 'Routed by length', payload: {
    alert_id: 'inc-3318', service: 'checkout-web', severity: 'medium', repo: 'acme/storefront', error: LONG_TRACE,
  } },
];

// ---------- state ----------
let session = store.get(LS.session, null);
if (!session) { session = 's-' + Math.random().toString(36).slice(2, 12); store.set(LS.session, session); }
let current = PRESETS[0];
let running = false;

const pruneHistory = () => {
  const t = Date.now();
  const h = store.get(LS.history, []).filter((x) => t - x.ts <= WINDOW);
  store.set(LS.history, h);
  return h;
};

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const dedupKey = (body) => (body && body.alert_id ? String(body.alert_id) : JSON.stringify(body).slice(0, 200));

// ---------- presets & editor ----------
const editor = $('#editor');
function renderPresets() {
  $('#presets').innerHTML = PRESETS.map((p) => `
    <button type="button" class="preset" role="radio" aria-checked="${p.id === current.id}" data-id="${p.id}">
      <span class="dot ${p.tone}" aria-hidden="true"></span>
      <b>${esc(p.label)}</b>
      <small>${esc(p.expect)}</small>
    </button>`).join('');
}
function loadPreset(p) {
  current = p;
  editor.value = JSON.stringify(p.payload, null, 2);
  checkJSON();
  renderPresets();
  const note = $('#presetNote');
  if (p.storm) {
    note.hidden = false;
    note.textContent = 'Alert storm: the monitor fires inc-1042 again. If it has not arrived in the last 10 minutes, the playground replays the first delivery 42 s earlier so you can see the repeat get dropped.';
  } else note.hidden = true;
}
function checkJSON() {
  const st = $('#jsonState');
  let ok = true;
  if (!editor.value.trim()) { st.textContent = 'Empty payload'; ok = false; } else {
    try { JSON.parse(editor.value); st.textContent = 'Valid JSON'; } catch { st.textContent = 'Invalid JSON, gate 2 will reject it'; ok = false; }
  }
  st.className = 'json-state ' + (ok ? 'ok' : 'bad');
  editor.setAttribute('aria-invalid', String(!ok));
  return ok;
}
const markCustom = () => { current = { id: 'custom' }; renderPresets(); $('#presetNote').hidden = true; };
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('.preset');
  if (!b || running) return;
  loadPreset(PRESETS.find((p) => p.id === b.dataset.id));
});
editor.addEventListener('input', () => { checkJSON(); if (current.id !== 'custom') markCustom(); });
editor.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});
$('#freshBtn').addEventListener('click', () => {
  try {
    const o = JSON.parse(editor.value);
    o.alert_id = 'inc-' + (1000 + Math.floor(Math.random() * 9000));
    editor.value = JSON.stringify(o, null, 2);
    checkJSON();
    markCustom();
  } catch { flash('Fix the JSON first, then generate a new alert_id.'); }
});
$('#resetBtn').addEventListener('click', () => {
  store.set(LS.history, []);
  session = 's-' + Math.random().toString(36).slice(2, 12);
  store.set(LS.session, session);
  flash('Dedupe memory cleared for this browser.');
});
function flash(msg) { const n = $('#presetNote'); n.hidden = false; n.textContent = msg; }
function showError(msg) { const b = $('#errorBox'); b.hidden = !msg; b.textContent = msg || ''; }

// ---------- pipeline ----------
const row = (id, idx, name, rule, step) => `
    <li class="gate idle${step ? ' step' : ''}" id="${id}">
      <div class="gate-row">
        <span class="idx">${idx}</span>
        <div><b>${name}</b><span class="rule">${rule}</span></div>
        <span class="st"></span>
        <span class="ms"></span>
      </div>
      <p class="detail"></p>
    </li>`;
function renderPipeline() {
  $('#pipeline').innerHTML = GATES.map(([name, rule], i) =>
    row('g' + (i + 1), String(i + 1).padStart(2, '0'), name, rule) +
    (i === 4 ? row('gLLM', 'M', 'Model call', 'Diagnose and propose a patch. Never writes.', true) : '')).join('');
}
const LABEL = { pass: 'Pass', block: 'Blocked', fail: 'Failed', skip: 'Skipped', run: 'Running' };
function setGate(el, status, ms, detail) {
  el.className = `gate ${el.id === 'gLLM' ? 'step ' : ''}${status}`;
  const st = el.querySelector('.st');
  st.className = 'st ' + status;
  st.textContent = LABEL[status] || status;
  el.querySelector('.ms').textContent = ms != null ? fmtMs(ms) : '';
  el.querySelector('.detail').textContent = detail || '';
}
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : (ms < 10 ? ms.toFixed(2) : ms.toFixed(0)) + ' ms');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

async function animate(data) {
  for (const g of data.gates) {
    const el = $('#g' + g.id);
    if (g.status === 'skip') { setGate(el, 'skip', null, g.detail); continue; }
    setGate(el, 'run', null, '');
    await sleep(reduced ? 40 : 320);
    setGate(el, g.status, g.ms, g.detail);
    if (g.id === 5) {
      const step = $('#gLLM');
      setGate(step, 'run', null, '');
      await sleep(reduced ? 40 : 480);
      const live = data.mode === 'live';
      setGate(step, 'pass', live ? data.llm.ms : null,
        `${live ? 'Executed on ' + data.executor : 'Demo data: templated fix'} · priced as ${data.route.model} · ${data.llm.tokens_in} in / ${data.llm.tokens_out} out tokens.`);
    }
  }
  if (data.outcome === 'duplicate' || data.outcome === 'rejected') setGate($('#gLLM'), 'skip', null, 'No tokens spent.');
}

// ---------- result ----------
const money = (n) => (n === 0 ? '$0.0000' : n < 0.0001 ? '<$0.0001' : '$' + n.toFixed(4));
function diffHTML(patch) {
  return String(patch).split('\n').map((l) => {
    const c = l.startsWith('+++') || l.startsWith('---') ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'r' : '';
    return `<span class="dl ${c}">${esc(l) || ' '}</span>`;
  }).join('');
}
const OUTCOME = {
  duplicate: ['Dropped · duplicate', 'warn'],
  rejected: ['Rejected · 422', 'bad'],
  escalated: ['Escalated to a person', 'warn'],
  awaiting_approval: ['Awaiting approval', 'ok'],
};

function renderResult(data, body) {
  $('#resultCard').hidden = false;
  const [txt, tone] = OUTCOME[data.outcome] || [data.outcome, ''];
  const pill = $('#outcomePill');
  pill.textContent = txt; pill.className = 'badge ' + tone;

  const c = data.cost || {};
  const saved = c.baseline_usd ? Math.round((1 - c.usd / c.baseline_usd) * 100) : 0;
  $('#stats').innerHTML = [
    ['Model', data.route ? data.route.model : 'None', data.route ? `${data.route.tier} tier · ${data.route.reason}` : 'Stopped before routing'],
    ['Cost this run', money(c.usd || 0), c.tokens_in ? `${c.tokens_in} in / ${c.tokens_out} out tokens · estimated` : 'No model call'],
    ['vs always-strong', c.baseline_usd ? (saved > 0 ? `−${saved}%` : 'Same') : '$0 spent', c.baseline_usd ? `${money(c.baseline_usd)} on claude-sonnet-4-5` : 'Blocked before the model'],
    ['Pipeline time', data.total_ms + ' ms', data.mode === 'live' ? `Live · ${data.executor}${c.executor_usd ? ' · actual ' + money(c.executor_usd) : ''}` : 'Demo data · gates run for real'],
  ].map(([k, v, s]) => `<div class="stat"><small>${k}</small><b title="${esc(v)}">${esc(v)}</b><span>${esc(s)}</span></div>`).join('');

  const rb = $('#resultBody');
  const stopped = data.gates.find((g) => g.status === 'block');
  const stopBox = (g, bad) => `<div class="stop${bad ? ' bad' : ''}"><b>Stopped at gate ${g.id} · ${esc(g.name)}</b><p>${esc(g.detail)}</p>`;
  if (data.outcome === 'duplicate' || data.outcome === 'rejected') {
    rb.innerHTML = `${stopBox(stopped, data.outcome === 'rejected')}
      ${data.outcome === 'duplicate' ? '<p>To run it again as a fresh incident, click <b>New alert_id</b>.</p>' : ''}
      <p class="mono small">Webhook replied ${data.webhook.status} ${esc(JSON.stringify(data.webhook.body))}</p></div>`;
    return;
  }
  const fix = `
    <div class="fix">
      <h3>Proposed fix <span class="badge plain ${data.fix.confidence >= 0.8 ? 'ok' : 'bad'}">Confidence ${data.fix.confidence.toFixed(2)}</span></h3>
      <p>${esc(data.fix.diagnosis)}</p>
      ${data.fix.rationale ? `<p class="rationale">${esc(data.fix.rationale)}</p>` : ''}
    </div>`;
  if (data.outcome === 'escalated') {
    const g6 = data.gates.find((g) => g.id === 6);
    const checks = (g6.data.checks || []).map((x) => `<li class="${x.ok ? 'ok' : 'no'}">${x.ok ? ICON.ok : ICON.no}${esc(x.name)}<span>${esc(x.note)}</span></li>`).join('');
    rb.innerHTML = `${stopBox(stopped, false)}</div>
      <div class="two">
        <div class="sec">${fix}<h3 style="margin-top:14px">Sandbox checks</h3><ul class="checks">${checks}</ul></div>
        <div class="sec"><h3>Patch</h3><pre class="diff">${diffHTML(data.fix.patch)}</pre></div>
      </div>
      ${slackShell(`<p class="slack-text"><b>${esc(body.service)}</b>: agent not confident or sandbox failed. Needs a person.</p><p class="slack-ctx">${esc(data.fix.diagnosis)}</p>`, false)}`;
    return;
  }
  rb.innerHTML = `<div class="two">${fix}${slackShell(`
      <p class="slack-title">${esc(body.service)} · fix ready for review</p>
      <p class="slack-text"><b>${esc(body.service)}</b> · ${esc(data.fix.diagnosis)}</p>
      <p class="slack-ctx">Confidence ${data.fix.confidence.toFixed(2)} · sandbox tests passed · ${esc(data.route.model)} · <code>${esc(body.alert_id)}</code></p>
      <pre class="diff slack-diff">${diffHTML(data.fix.patch)}</pre>
      <div class="slack-actions" id="slackActions">${decisionButtons()}</div>`, true)}</div>`;
  $('#slackActions').addEventListener('click', (e) => onDecision(e, data));
}
const decisionButtons = () => '<button type="button" class="btn btn-primary btn-sm sbtn" data-d="approved">Approve</button><button type="button" class="btn btn-sm btn-danger sbtn" data-d="rejected">Reject</button>';
function slackShell(inner, interactive) {
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<div class="slack ${interactive ? '' : 'muted'}">
    <div class="slack-bar"><b># incidents</b><span>Slack preview</span></div>
    <div class="slack-msg">
      <div class="avatar" aria-hidden="true">IA</div>
      <div>
        <div class="slack-meta"><b>Incident Agent</b><span class="app">APP</span><span>${t}</span></div>
        ${inner}
      </div>
    </div>
  </div>`;
}
function onDecision(e, data) {
  const b = e.target.closest('.sbtn');
  if (!b) return;
  const box = $('#slackActions');
  const d = b.dataset.d;
  if (d === 'cancel') { box.innerHTML = decisionButtons(); return; }
  if (!b.classList.contains('confirm')) {
    // double confirm, like approvalType "double" in the n8n node
    box.innerHTML = `<span class="confirm-q">${d === 'approved' ? 'Ship this patch? This opens the PR.' : 'Reject and close this fix?'}</span>
      <button type="button" class="btn btn-sm sbtn confirm ${d === 'approved' ? 'btn-primary' : 'btn-danger'}" data-d="${d}">Yes, ${d === 'approved' ? 'approve' : 'reject'}</button>
      <button type="button" class="btn btn-sm sbtn" data-d="cancel">Cancel</button>`;
    box.querySelector('.confirm').focus();
    return;
  }
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  box.innerHTML = `<span class="decided ${d}" role="status">${d === 'approved' ? 'Approved' : 'Rejected'} by you at ${t}${d === 'approved' ? ' · PR opened by CI (simulated)' : ' · no change shipped'}</span>`;
  updateAudit(data.run_id, d);
}

// ---------- audit ----------
function addAudit(r) {
  const a = store.get(LS.audit, []);
  a.unshift(r);
  store.set(LS.audit, a.slice(0, 100));
  renderAudit();
}
function updateAudit(id, decision) {
  const a = store.get(LS.audit, []);
  const r = a.find((x) => x.id === id);
  if (r) { r.decision = decision; r.decided_at = Date.now(); }
  store.set(LS.audit, a);
  renderAudit();
}
const OUT = { duplicate: ['Duplicate', 'warn'], rejected: ['422 rejected', 'bad'], escalated: ['Escalated', 'warn'], awaiting_approval: ['Approval', 'ok'] };
const DEC = { pending: ['Pending', ''], approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'], 'auto-blocked': ['Auto-blocked', ''], 'human review': ['Human review', 'warn'] };
function renderAudit() {
  const a = store.get(LS.audit, []);
  $('#auditEmpty').hidden = a.length > 0;
  $('#auditBody').innerHTML = a.map((r) => {
    const o = OUT[r.outcome] || [r.outcome, ''];
    const d = DEC[r.decision] || [r.decision, ''];
    return `<tr>
      <td class="mono">${new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
      <td class="mono">${esc(r.alert_id || '—')}</td>
      <td>${esc(r.service || '—')}</td>
      <td><span class="tag ${o[1]}">${esc(o[0])}</span></td>
      <td class="mono">${esc(r.model || '—')}</td>
      <td class="mono r">${r.confidence != null ? r.confidence.toFixed(2) : '—'}</td>
      <td class="mono r">${money(r.cost || 0)}</td>
      <td><span class="tag ${d[1]}">${esc(d[0])}</span></td>
    </tr>`;
  }).join('');
}
$('#clearBtn').addEventListener('click', () => { store.set(LS.audit, []); renderAudit(); });
$('#exportBtn').addEventListener('click', () => {
  const a = store.get(LS.audit, []);
  if (!a.length) return;
  const cols = ['ts', 'alert_id', 'service', 'outcome', 'model', 'confidence', 'cost', 'decision', 'hash', 'mode'];
  const csv = [cols.join(',')].concat(a.map((r) => cols.map((c) => `"${String(c === 'ts' ? new Date(r.ts).toISOString() : r[c] ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: 'guardrails-audit.csv' });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------- run ----------
function setMode(mode) {
  const b = $('#modeBadge');
  const live = mode === 'live';
  b.className = 'badge' + (live ? ' ok' : '');
  b.textContent = live ? 'Live' : 'Demo data';
  b.title = live ? 'Fixes generated by Gemini; gates are deterministic' : 'Templated fixes; every gate still runs for real';
}

async function run() {
  if (running) return;
  running = true;
  const btn = $('#runBtn');
  btn.disabled = true; btn.querySelector('.btn-label').textContent = 'Running…';
  showError('');
  renderPipeline();
  $('#resultCard').hidden = true;
  $('#webhookOut').hidden = true;
  $('#pipeMeta').textContent = 'Running';
  const raw = editor.value;
  let body = null;
  try { body = JSON.parse(raw); } catch { /* gate 2 rejects */ }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);

  try {
    if (current.storm && body) {
      const h = pruneHistory();
      const hash = await sha256(dedupKey(body));
      if (!h.some((x) => x.hash === hash)) {
        h.push({ hash, ts: Date.now() - 42000, alert_id: body.alert_id, replay: true });
        store.set(LS.history, h);
      }
    }
    setGate($('#g1'), 'run', null, '');
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ raw, session, history: pruneHistory().map(({ hash, ts }) => ({ hash, ts })) }),
    });
    let data;
    try { data = await res.json(); } catch { throw new Error(`Server returned ${res.status} without JSON.`); }
    if (!res.ok) throw new Error(data.error || `Run failed (${res.status}).`);
    data.run_id = 'r-' + Date.now().toString(36);
    setMode(data.mode);

    if (data.outcome !== 'duplicate' && data.hash) {
      const h = pruneHistory();
      if (!h.some((x) => x.hash === data.hash)) { h.push({ hash: data.hash, ts: Date.now(), alert_id: body && body.alert_id }); store.set(LS.history, h); }
    }

    const wo = $('#webhookOut');
    wo.hidden = false;
    wo.innerHTML = `<span class="badge plain ${data.webhook.status === 200 ? 'ok' : 'bad'}">${data.webhook.status}</span><code>${esc(JSON.stringify(data.webhook.body))}</code><span>Replied before the agent runs</span>`;

    await animate(data);
    const stopped = data.gates.some((g) => g.status === 'block');
    $('#pipeMeta').textContent = stopped ? 'Stopped' : 'All gates passed';
    renderResult(data, body || {});
    addAudit({
      id: data.run_id, ts: Date.now(), alert_id: body && body.alert_id, service: body && body.service,
      outcome: data.outcome, model: data.route ? data.route.model : null, confidence: data.fix ? data.fix.confidence : null,
      cost: data.cost ? data.cost.usd : 0, decision: data.outcome === 'awaiting_approval' ? 'pending' : data.outcome === 'escalated' ? 'human review' : 'auto-blocked',
      hash: data.hash, mode: data.mode,
    });
    $('#resultCard').scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  } catch (err) {
    const msg = err.name === 'AbortError' ? `The run took longer than ${RUN_TIMEOUT_MS / 1000} s and was cancelled.` : err.message;
    $('#pipeMeta').textContent = 'Error';
    renderPipeline();
    showError(`Could not complete the run. ${msg}`);
  } finally {
    clearTimeout(timer);
    running = false;
    btn.disabled = false; btn.querySelector('.btn-label').textContent = 'Run gates';
  }
}
$('#runBtn').addEventListener('click', run);

// ---------- boot ----------
if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $('#runBtn kbd').textContent = '⌘ ↵';
renderPipeline();
loadPreset(PRESETS[0]);
renderAudit();
fetch('/api/status').then((r) => r.json()).then((s) => setMode(s.mode)).catch(() => setMode('demo'));
