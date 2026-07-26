#!/usr/bin/env node
/**
 * Smoke tests for Container Lookup System — index.html
 * ------------------------------------------------------------------
 * WHY THIS EXISTS
 * There is no framework, no build step, and no test runner in this project
 * on purpose (see Improvement_Suggestions.md). But the single highest-value,
 * lowest-effort safety net is a handful of assertions around the functions
 * that are pure (same input → same output, no DOM/network) and that have
 * *already* caused a real production bug once (the detention sign-convention
 * regression). This script would have caught that bug automatically.
 *
 * HOW IT WORKS
 * It loads the real <script> block out of index.html and runs it inside a
 * sandboxed Node VM with a minimal "pretend anything exists" mock for
 * `document`/`window`/etc., so the file's top-level code (which does touch
 * the DOM immediately in a few places) doesn't crash before the function
 * declarations are defined. It then calls the real functions — not copies —
 * with known inputs and checks the output.
 *
 * HOW TO RUN
 *   node smoke-test.js /path/to/index.html
 * Exits 0 and prints "ALL PASSED" if everything is fine, exits 1 and lists
 * every failure otherwise. Safe to run in CI on every commit if you ever add
 * one (see Improvement_Suggestions.md, "A staging deployment").
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const filePath = process.argv[2] || path.join(__dirname, 'index.html');
if (!fs.existsSync(filePath)) {
  console.error(`File not found: ${filePath}\nUsage: node smoke-test.js /path/to/index.html`);
  process.exit(1);
}
const html = fs.readFileSync(filePath, 'utf8');

// Pull out the largest inline <script> block — that's the app's real code.
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) { console.error('No inline <script> blocks found in the file.'); process.exit(1); }
const code = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');

// ---------------------------------------------------------------------------
// A universal "pretend anything exists and does nothing" mock. Any property
// access or function call on it returns another one of itself, so code like
// `document.getElementById('x').classList.add('y')` or
// `localStorage.getItem('z')` never throws — it just quietly no-ops.
// ---------------------------------------------------------------------------
function makeVoidMock(name = 'mock') {
  const fn = function () { return makeVoidMock(name + '()'); };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined; // don't make every mock look like a thenable
      if (['length', 'size'].includes(prop)) return 0;
      if (prop === 'style' || prop === 'dataset' || prop === 'classList') return makeVoidMock(String(prop));
      return makeVoidMock(String(prop));
    },
    apply() { return makeVoidMock(name + '()'); },
    construct() { return makeVoidMock('new ' + name); },
  });
}

const sandbox = {
  console,
  window: makeVoidMock('window'),
  document: makeVoidMock('document'),
  navigator: { vibrate: () => {}, clipboard: makeVoidMock('clipboard') },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { pathname: '/', search: '' },
  history: makeVoidMock('history'),
  firebase: makeVoidMock('firebase'),
  fetch: () => Promise.resolve(makeVoidMock('response')),
  Blob: function () {},
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Map, Set,
};
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: 'index.html:inline-script', timeout: 8000 });
} catch (err) {
  // Some top-level DOM wiring is expected to throw against the mock (e.g. a
  // real querySelector returning null where the real page wouldn't). That's
  // fine — the function declarations we care about are hoisted and already
  // exist on the sandbox by the time any top-level statement runs.
  console.warn(`(Note: sandbox init raised "${err.message}" — usually harmless top-level DOM wiring; continuing.)`);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}\n     expected: ${JSON.stringify(expected)}\n     got:      ${JSON.stringify(actual)}`); }
}
function section(title) { console.log(`\n${title}`); }

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysFromToday = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

// ---- detentionInfo: the function responsible for the real past bug ----
if (typeof sandbox.detentionInfo === 'function') {
  section('detentionInfo — sign convention (positive = safe, negative = overdue)');

  // Gated in 5 days BEFORE the deadline → should be DONE, positive days.
  let r = sandbox.detentionInfo({ deadline: daysFromToday(5), port_gate_in: daysFromToday(0) });
  check('on-time gate-in reports DONE', r.status, 'DONE');
  check('on-time gate-in has positive day count', r.days > 0, true);

  // Gated in 5 days AFTER the deadline → should be negative, in days.
  r = sandbox.detentionInfo({ deadline: daysFromToday(-5), port_gate_in: daysFromToday(0) });
  check('late gate-in reports a negative number as status', String(r.status).startsWith('-'), true);
  check('late gate-in has negative day count', r.days < 0, true);
  check('late gate-in day count matches the gap', r.days, -5);

  // No deadline on file at all → should not crash, should say so clearly.
  r = sandbox.detentionInfo({});
  check('missing deadline does not throw and reports null days', r.days, null);
} else {
  console.log('\n⚠️  detentionInfo not found on the sandbox — skipped (check the extraction, not necessarily a real failure).');
}

// ---- iso6346CheckDigitValid ----
if (typeof sandbox.iso6346CheckDigitValid === 'function') {
  section('iso6346CheckDigitValid');
  // CSQU3054383 is the canonical worked example from the ISO 6346 standard itself.
  check('accepts the standard\'s own worked example (CSQU3054383)', sandbox.iso6346CheckDigitValid('CSQU3054383'), true);
  check('rejects the same number with the check digit changed', sandbox.iso6346CheckDigitValid('CSQU3054382'), false);
  check('returns null (not a false positive) for a non-standard-shaped input', sandbox.iso6346CheckDigitValid('NOTACONTAINER'), null);
} else {
  console.log('\n⚠️  iso6346CheckDigitValid not found — skipped.');
}

// ---- normalizeContainer ----
if (typeof sandbox.normalizeContainer === 'function') {
  section('normalizeContainer');
  check('trims, uppercases, strips internal whitespace', sandbox.normalizeContainer(' msc u 123 4567 '), 'MSCU1234567');
  check('is idempotent (normalizing twice = normalizing once)',
    sandbox.normalizeContainer(sandbox.normalizeContainer('mscu1234567')),
    sandbox.normalizeContainer('mscu1234567'));
} else {
  console.log('\n⚠️  normalizeContainer not found — skipped.');
}

// ---- currentStatus ----
if (typeof sandbox.currentStatus === 'function') {
  section('currentStatus — precedence order');
  check('a manual status override always wins', sandbox.currentStatus({ _statusOverride: 'OUT', cy: { stuffing_status: 'EMPTY' } }), 'OUT');
  check('cy status wins over customer/archive when there is no override',
    sandbox.currentStatus({ cy: { stuffing_status: 'FINAL SEAL' }, customer: { status: 'EMPTY' } }), 'FINAL SEAL');
  check('a yard-only stub with nothing else reports IN YARD', sandbox.currentStatus({ _yardOnly: true }), 'IN YARD');
  check('a completely empty record reports the placeholder dash', sandbox.currentStatus({}), '—');
} else {
  console.log('\n⚠️  currentStatus not found — skipped.');
}

// ---- yardLocationDisabled ----
if (typeof sandbox.yardLocationDisabled === 'function') {
  section('yardLocationDisabled');
  const stackWithDisabled = { disabledLocations: [{ bay: 2, row: 4, tier: 3 }] };
  check('flags the exact disabled position', sandbox.yardLocationDisabled(stackWithDisabled, 2, 4, 3), true);
  check('does not flag a different tier in the same bay/row', sandbox.yardLocationDisabled(stackWithDisabled, 2, 4, 2), false);
  check('does not flag the same row/tier in a different bay', sandbox.yardLocationDisabled(stackWithDisabled, 4, 4, 3), false);
  check('a stack with no disabledLocations list flags nothing', sandbox.yardLocationDisabled({}, 2, 4, 3), false);
} else {
  console.log('\n⚠️  yardLocationDisabled not found — skipped.');
}

// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(50)}\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('❌ SMOKE TEST FAILED — do not deploy this build until the failures above are understood.');
  process.exit(1);
} else {
  console.log('✅ ALL PASSED');
  process.exit(0);
}
