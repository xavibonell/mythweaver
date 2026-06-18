// Scene-composition eval CLI (docs/VISUAL-LAYER-TODO.md Phase E). Runs each brief through the real
// setup pipeline, checks deterministic invariants, judges composition, and gates vs a pinned baseline.
//   npm run build && npm run scene:eval          # run + gate
//   npm run build && npm run scene:eval:update    # run + (re)write the baseline
// Makes real API calls (DM + Director + judge), ~$0.15–0.3 per run.
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

const { runSceneEvals } = await import('../apps/server/dist/scene-eval/runner.js');
const { SCENE_RUBRIC } = await import('../apps/server/dist/scene-eval/rubric.js');

const update = process.argv.includes('--update');
const runs = Number(process.env.SCENE_EVAL_RUNS || 1);
const baselinePath = resolve('apps/server/src/scene-eval/baseline.json');

console.log(`Running ${runs} run(s) of the scene eval — real API calls (DM + Director + judge)…\n`);
const report = await runSceneEvals({ runs });

console.log('Per-case invariants + shape:');
for (const c of report.perCase) {
  console.log(`  ${(c.invariants.ok ? 'ok' : 'FAIL').padEnd(5)} ${c.id.padEnd(16)} ${c.summary}`);
  for (const f of c.invariants.failures) console.log(`        ↳ ${f}`);
}
console.log('\nMean composition scores (0–5):');
for (const d of SCENE_RUBRIC) console.log(`  ${d.key.padEnd(16)} ${report.means[d.key].toFixed(2)}`);

const invariantFailures = report.invariantFailures ?? [];
if (invariantFailures.length) {
  console.log(`\n⚠ ${invariantFailures.length} composition invariant(s) FAILED:`);
  for (const f of invariantFailures) console.log(`  FAIL ${f}`);
}

if (update) {
  if (invariantFailures.length) console.log('\n⚠ Pinning a baseline with failing invariants — investigate before relying on the gate.');
  writeFileSync(baselinePath, `${JSON.stringify({ means: report.means, runs, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`\nBaseline written -> ${baselinePath}`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.log('\nNo baseline yet. Run `npm run scene:eval:update` to pin one.');
  process.exit(invariantFailures.length ? 1 : 0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
let failed = invariantFailures.length > 0; // invariant failures block the gate
console.log('\nRegression gate (fail if > 0.4 below baseline):');
for (const d of SCENE_RUBRIC) {
  const cur = report.means[d.key];
  const base = baseline.means[d.key] ?? 0;
  const ok = cur >= base - 0.4;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${d.key.padEnd(16)} ${cur.toFixed(2)} (baseline ${base.toFixed(2)})`);
}
if (invariantFailures.length) console.log(`\nGate FAILED on ${invariantFailures.length} composition invariant(s) (see above).`);
process.exit(failed ? 1 : 0);
