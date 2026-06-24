// Visual judge CLI (strategy A) — score a CAPTURED render against the visual rubric with a lens panel,
// and gate changes against a pinned baseline so a regression can't ship on anyone's word alone.
//
// Pipeline: render → snapshot() → POST /scene/eval/capture → scene-eval/captures/<name>.png, then:
//   npm run build
//   npm run scene:judge:visual -- --name building-house [--subject "..."] [--tile 16]
//   npm run scene:judge:visual -- --name building-house --baseline   # run x3, pin scores+spread
//   npm run scene:judge:visual -- --name building-house --gate        # run x3, FAIL (exit 1) on regression
//   ...add --repeat N to change the run count (stability sampling). Real Anthropic vision calls (~3/run).
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Minimal .env loader (same as scene-eval.mjs).
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const { AnthropicProvider } = await import('@mythweaver/llm');
const { runVisualJudge } = await import('../apps/server/dist/scene-eval/visual-judge.js');
const { capturePath } = await import('../apps/server/dist/scene-eval/capture.js');
const { RUBRICS } = await import('../apps/server/dist/scene-eval/visual-rubric.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (process.argv.includes(`--${name}`) ? '' : fallback);
};
const has = (name) => process.argv.includes(`--${name}`);

const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', gray: '\x1b[90m', bold: '\x1b[1m', green: '\x1b[32m', reset: '\x1b[0m' };
const sevColor = { critical: C.red, major: C.yellow, minor: C.gray };
const bar = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(5 - Math.round(n));
const mean = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;

const mode = has('gate') ? 'gate' : has('baseline') ? 'baseline' : 'judge';
const repeat = Math.max(1, Number(arg('repeat', mode === 'judge' ? '1' : '3')) || 1);
const name = arg('name');
const img = arg('img') ?? (name ? capturePath(name) : undefined);
const baselinePath = new URL('../apps/server/src/scene-eval/visual-baseline.json', import.meta.url).pathname;

if (!img) {
  console.error('usage: --name <capture-name> | --img <path.png>  [--subject "..."] [--tile 16] [--baseline|--gate] [--repeat N]');
  process.exit(2);
}
if (!existsSync(img)) {
  console.error(`no capture at ${img} — capture the render first (Scene Lab → POST /scene/eval/capture).`);
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required for the visual judge (real vision calls).');
  process.exit(2);
}
if ((mode === 'gate' || mode === 'baseline') && !name) {
  console.error(`--${mode} requires --name (the baseline is keyed by capture name).`);
  process.exit(2);
}

const subject = arg('subject') ?? (name ? `a rendered scene "${name}"` : 'a rendered top-down RPG scene');
const tilePx = Number(arg('tile', '16'));
const model = arg('model');
const rubricKey = arg('rubric', 'building');
const RUBRIC = RUBRICS[rubricKey] ?? RUBRICS.building;
const DIMS = RUBRIC.dimensions;
// Optional REFERENCE image to compare against: --ref <path>, else auto-use refs/<rubric>.png if present.
const refDefault = new URL(`../apps/server/src/scene-eval/refs/${rubricKey}.png`, import.meta.url).pathname;
const refImg = arg('ref') ?? (existsSync(refDefault) ? refDefault : undefined);
if (refImg) console.log(`${C.dim}comparing against reference: ${refImg}${C.reset}`);

// Direct construction so we can raise retries (the judge isn't latency-sensitive; ride out 429/529).
const llm = new AnthropicProvider({ retries: 5, timeoutMs: 90_000 });

console.log(`${C.dim}judging ${img} — ${mode}${repeat > 1 ? ` ×${repeat}` : ''} …${C.reset}`);
const runs = [];
for (let i = 0; i < repeat; i++) {
  if (repeat > 1) process.stdout.write(`${C.dim}  run ${i + 1}/${repeat} …${C.reset}\n`);
  runs.push(await runVisualJudge(llm, { imagePath: img, subject, tilePx, model, rubric: rubricKey, refImagePath: refImg }));
}

// Aggregate dimension scores across runs: mean + spread (max−min, the judge's run-to-run noise).
const dimMean = {}, dimSpread = {};
for (const d of DIMS) {
  const xs = runs.map((r) => r.scores[d.key]);
  dimMean[d.key] = mean(xs);
  dimSpread[d.key] = Math.max(...xs) - Math.min(...xs);
}
const meanScore = mean(runs.map((r) => r.meanScore));
const last = runs[runs.length - 1];

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}VISUAL JUDGE${C.reset} — ${last.subject}`);
console.log(`${C.dim}${last.imagePath} · panel: ${last.lenses.map((l) => l.lens).join(', ')} · model: ${last.lenses[0]?.model ?? '?'}${repeat > 1 ? ` · ${repeat} runs` : ''}${C.reset}\n`);
console.log(`${C.bold}Scores (0–5)${C.reset}              ${C.dim}${repeat > 1 ? 'mean  spread' : 'median'}${C.reset}`);
for (const d of DIMS) {
  const m = dimMean[d.key];
  const spread = repeat > 1 ? `  ${C.dim}±${dimSpread[d.key]}${C.reset}` : '';
  console.log(`  ${d.label.padEnd(24)} ${bar(m)} ${m}${spread}`);
}
console.log(`  ${C.bold}${'MEAN'.padEnd(24)}${C.reset}       ${C.bold}${meanScore}${C.reset}\n`);

const count = (s) => last.defects.filter((d) => d.severity === s).length;
console.log(`${C.bold}Defects${C.reset} ${C.dim}(latest run)${C.reset}  ${C.red}${count('critical')} critical${C.reset} · ${C.yellow}${count('major')} major${C.reset} · ${C.gray}${count('minor')} minor${C.reset}`);
for (const d of last.defects) {
  const tag = `${sevColor[d.severity]}${d.severity.toUpperCase().padEnd(8)}${C.reset}`;
  const consensus = d.consensus >= 2 ? `${C.green}[${d.consensus}/${last.lenses.length}]${C.reset}` : `${C.dim}[${d.consensus}/${last.lenses.length}]${C.reset}`;
  console.log(`  ${tag} ${C.dim}(${d.category})${C.reset} ${C.bold}${d.unit}${C.reset}/${d.region} ${consensus}`);
  console.log(`           ${d.detail}`);
}
console.log(`\n${C.dim}tokens: ${last.usage.inputTokens} in / ${last.usage.outputTokens} out per run × ${repeat}${C.reset}`);

const out = img.replace(/\.png$/i, '') + '.judge.json';
writeFileSync(out, JSON.stringify({ ...last, aggregate: { scores: dimMean, spread: dimSpread, meanScore, runs: repeat } }, null, 2));
console.log(`${C.dim}full report → ${out}${C.reset}`);

// ── Baseline / Gate ──────────────────────────────────────────────────────────
const loadBaselines = () => (existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {});

if (mode === 'baseline') {
  const all = loadBaselines();
  all[name] = { scores: dimMean, meanScore, spread: dimSpread, runs: repeat, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(all, null, 2) + '\n');
  console.log(`\n${C.green}baseline pinned${C.reset} for "${name}" → ${baselinePath}`);
  process.exit(0);
}

if (mode === 'gate') {
  const base = loadBaselines()[name];
  if (!base) {
    console.log(`\n${C.yellow}no baseline for "${name}"${C.reset} — pin one: npm run scene:judge:visual -- --name ${name} --baseline`);
    process.exit(2);
  }
  console.log(`\n${C.bold}Regression gate${C.reset} ${C.dim}(baseline pinned ${base.updatedAt})${C.reset}`);
  let failed = false;
  for (const d of DIMS) {
    const cur = dimMean[d.key], baseVal = base.scores[d.key] ?? 0;
    // A regression must exceed the judge's own noise (baseline spread) plus a margin.
    const margin = Math.max(0.6, (base.spread?.[d.key] ?? 0) + 0.3);
    const ok = cur >= baseVal - margin;
    if (!ok) failed = true;
    const delta = Math.round((cur - baseVal) * 100) / 100;
    const arrow = delta > 0 ? `${C.green}+${delta}${C.reset}` : delta < 0 ? `${C.red}${delta}${C.reset}` : `${C.dim}0${C.reset}`;
    console.log(`  ${ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`} ${d.key.padEnd(20)} ${cur} vs ${baseVal} (${arrow}, margin ${margin})`);
  }
  const meanOk = meanScore >= base.meanScore - 0.4;
  if (!meanOk) failed = true;
  console.log(`  ${meanOk ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`} ${'MEAN'.padEnd(20)} ${meanScore} vs ${base.meanScore}`);
  console.log(failed ? `\n${C.red}GATE FAILED — a dimension regressed beyond noise.${C.reset}` : `\n${C.green}GATE PASSED.${C.reset}`);
  process.exit(failed ? 1 : 0);
}
