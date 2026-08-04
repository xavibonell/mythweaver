// Headless render + visual judge in ONE command — no browser. Renders a Scene-Lab component
// (kind+seed) to a PNG via the pure-Node compositor, writes it to scene-eval/captures/<name>.png,
// then delegates to scripts/visual-judge.mjs (full report + baseline/gate machinery).
//
//   npm run build
//   npm run scene:judge:auto -- --kind precinct --seed 1
//   npm run scene:judge:auto -- --kind building:tavern --seed 3 --count 1
//   npm run scene:judge:auto -- --kind precinct --seed 1 --baseline      # pin a baseline
//   npm run scene:judge:auto -- --kind precinct --seed 1 --no-judge      # render only (open the PNG)
// Real Anthropic vision calls (~3/run) unless --no-judge. Needs ANTHROPIC_API_KEY (the judge child loads .env).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const { buildComponentSheet, renderSceneMapToPng } = await import('@mythweaver/scene');
const { capturePath } = await import('../apps/server/dist/scene-eval/capture.js');

const kind = arg('kind', 'building:tavern');
const seed = Number(arg('seed', '1'));
const count = Number(arg('count', '1')); // count 1 = one instance (precinct/town clamp tiny above 1)
const name = arg('name', `${kind.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}-${seed}`);
const assetsRoot = new URL('../apps/web/public', import.meta.url).pathname;

const scene = buildComponentSheet(kind, count, seed);
const buf = renderSceneMapToPng(scene, { assetsRoot });
const out = capturePath(name);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`rendered ${kind} (count ${count}, seed ${seed}) → ${out}  [${scene.grid.cols}×${scene.grid.rows}, ${scene.objects.length} objects]`);

if (process.argv.includes('--no-judge')) process.exit(0);

// Delegate to the existing judge (reuses its report/baseline/gate). Pass through everything except
// our render-only flags (--kind/--seed/--count consume a value; --no-judge is a bare flag).
const passthrough = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--kind' || a === '--seed' || a === '--count') { i++; continue; }
  if (a === '--no-judge') continue;
  passthrough.push(a);
}
if (!passthrough.includes('--name')) passthrough.push('--name', name);
// Auto-select the rubric by kind: settlement compositions get the town rubric, single buildings the building one.
if (!passthrough.includes('--rubric')) {
  const isTown = /precinct|town|village|city/.test(kind);
  passthrough.push('--rubric', isTown ? 'town' : 'building');
}
if (!passthrough.includes('--subject') && !passthrough.includes('--gate') && !passthrough.includes('--baseline'))
  passthrough.push('--subject', /precinct|town|village|city/.test(kind)
    ? `a rendered top-down slice of a town/settlement ("${kind}", seed ${seed})`
    : `a rendered top-down RPG scene "${kind}" (seed ${seed})`);
const res = spawnSync('node', [new URL('./visual-judge.mjs', import.meta.url).pathname, ...passthrough], { stdio: 'inherit' });
process.exit(res.status ?? 0);
