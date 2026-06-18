// Eval runner CLI (spec §10). Builds + runs the eval set, judges narration, and
// compares to the pinned baseline (or writes one with --update). Makes real API calls.
//   npm run build && npm run eval           # run + gate against baseline
//   npm run build && npm run eval:update    # run + (re)write the baseline
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader.
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const { runEvals } = await import('../apps/server/dist/eval/runner.js');
const { RUBRIC_DIMENSIONS } = await import('../apps/server/dist/eval/rubric.js');

const update = process.argv.includes('--update');
const runs = Number(process.env.EVAL_RUNS || 1);
const baselinePath = resolve('apps/server/src/eval/baseline.json');

console.log(`Running ${runs} run(s) of the eval set — real API calls, ~$0.2–0.4…\n`);
const report = await runEvals({ runs });

console.log('Per-case tool calls + rules-correctness assertions:');
for (const c of report.perCase) {
  const status = c.assertions.ok ? 'ok' : 'FAIL';
  console.log(`  ${status.padEnd(5)} ${c.id.padEnd(16)} [${c.toolCalls.join(', ') || '—'}]`);
  for (const f of c.assertions.failures) console.log(`        ↳ ${f}`);
}
console.log('\nMean scores (0–5):');
for (const d of RUBRIC_DIMENSIONS) console.log(`  ${d.key.padEnd(20)} ${report.means[d.key].toFixed(2)}`);

// Deterministic rules-correctness checks (spec §10 component 1) — a failure blocks release.
const assertionFailures = report.assertionFailures ?? [];
if (assertionFailures.length) {
  console.log(`\n⚠ ${assertionFailures.length} rules-correctness assertion(s) FAILED:`);
  for (const f of assertionFailures) console.log(`  FAIL ${f}`);
}

if (update) {
  if (assertionFailures.length) console.log('\n⚠ Pinning a baseline with failing rules-correctness assertions — investigate before relying on the gate.');
  writeFileSync(baselinePath, `${JSON.stringify({ means: report.means, runs, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`\nBaseline written -> ${baselinePath}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.log('\nNo baseline yet. Run `npm run eval:update` to pin one.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
let failed = assertionFailures.length > 0; // rules-correctness failures block the gate
console.log('\nRegression gate (fail if > 0.4 below baseline):');
for (const d of RUBRIC_DIMENSIONS) {
  const cur = report.means[d.key];
  const base = baseline.means[d.key] ?? 0;
  const ok = cur >= base - 0.4;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${d.key.padEnd(20)} ${cur.toFixed(2)} (baseline ${base.toFixed(2)})`);
}
if (assertionFailures.length) console.log(`\nGate FAILED on ${assertionFailures.length} rules-correctness assertion(s) (see above).`);
process.exit(failed ? 1 : 0);
