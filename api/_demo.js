// Deterministic templated "model output" used when GEMINI_API_KEY is absent or the call fails.
// Shapes are identical to the live model contract enforced by Gate 5.

function where(error) {
  const m = String(error).match(/at\s+(?:[\w.<>]+\s+\()?([\w./-]+\.(?:js|ts|jsx|tsx|py|go|rb))(?::(\d+))?/);
  return { file: m ? m[1].replace(/^\.?\//, '') : 'src/index.js', line: m && m[2] ? Number(m[2]) : 12 };
}

export function demoFix(body) {
  const err = String(body.error || '');
  const text = `${err} ${body.service || ''} ${body.suggested_action || ''}`;

  // Risky production database change
  if (/(migrat|deadlock|lock wait|column|schema|ALTER|postgres|mysql|SQLSTATE)/i.test(text)) {
    return {
      diagnosis: 'Writes to orders block on a lock held by the legacy_status backfill; the column is unused by current code.',
      rationale: 'Dropping the legacy column removes the lock contention, but it is an irreversible schema change on production data with no verified backup. This needs a DBA, not an auto-fix.',
      confidence: 0.58,
      tools_used: ['logs.search:read', 'git.log:read'],
      patch: [
        '--- a/db/migrations/20261031_drop_legacy_status.sql',
        '+++ b/db/migrations/20261031_drop_legacy_status.sql',
        '@@ -0,0 +1,3 @@',
        '+-- unblock writes on orders',
        '+ALTER TABLE orders DROP COLUMN legacy_status;',
        '+DROP INDEX IF EXISTS idx_orders_legacy_status;',
      ].join('\n'),
    };
  }

  // Long front-end trace (router sends this to the strong tier by length)
  if (/(hydrat|React|useEffect|render|window is not defined|document is not defined)/i.test(err)) {
    const { file, line } = where(err);
    return {
      diagnosis: `${file} reads window.localStorage during server render, so SSR throws and the cart page falls back to a blank shell.`,
      rationale: 'Guarding the browser-only access keeps the server render pure; the cart value hydrates on the client on first effect. Small, local, and covered by the existing CartBadge test.',
      confidence: 0.86,
      tools_used: ['git.blame:read', 'logs.search:read'],
      patch: [
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -${line},2 +${line},5 @@`,
        '-  const saved = window.localStorage.getItem("cart");',
        '-  const [count, setCount] = useState(saved ? JSON.parse(saved).length : 0);',
        '+  const [count, setCount] = useState(0);',
        '+  useEffect(() => {',
        '+    const saved = window.localStorage.getItem("cart");',
        '+    if (saved) setCount(JSON.parse(saved).length);',
        '+  }, []);',
      ].join('\n'),
    };
  }

  // Null / undefined property access
  const np = err.match(/(?:Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '?"?(\w+)'?"?\))?|NoneType' object has no attribute '(\w+)'|nil pointer)/i);
  if (np) {
    const { file, line } = where(err);
    const prop = np[2] || np[3] || 'amount';
    return {
      diagnosis: `req.body.${prop} is undefined when clients send a form-encoded body, and ${file}:${line} dereferences it without a guard.`,
      rationale: `Coerce with a safe default and reject non-numeric values with a 400 instead of crashing the worker. Matches the blame history: the guard was lost in the last refactor of ${file}.`,
      confidence: 0.91,
      tools_used: ['git.blame:read', 'git.log:read', 'logs.search:read'],
      patch: [
        `--- a/${file}`,
        `+++ b/${file}`,
        `@@ -${line},2 +${line},3 @@`,
        `-  const amt = req.body.${prop}.toFixed(2);`,
        `+  const amt = Number(req.body?.${prop} ?? NaN);`,
        `+  if (!Number.isFinite(amt)) return res.status(400).json({ error: "invalid ${prop}" });`,
        '   const charge = await gateway.charge(amt, req.user.id);',
      ].join('\n'),
    };
  }

  // Unknown class of error: honest low confidence so Gate 7 escalates
  const { file, line } = where(err);
  return {
    diagnosis: `Unclassified failure in ${body.service}; logs do not point to a single root cause.`,
    rationale: 'Without a reproducible cause the safest change is extra logging around the failing call. That is not a fix, so confidence is kept low and a human should look.',
    confidence: 0.55,
    tools_used: ['logs.search:read'],
    patch: [
      `--- a/${file}`,
      `+++ b/${file}`,
      `@@ -${line},1 +${line},2 @@`,
      '+  logger.warn({ ctx: "incident-probe" }, "entering failing path");',
      '   return handler(req, res);',
    ].join('\n'),
  };
}
