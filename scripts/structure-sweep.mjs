// Structural-invariant sweep — the deterministic, $0 inner loop for the town builder.
// Builds a component over N seeds and tallies the four structural defect classes (see structure-check.ts),
// so we know EXACTLY how often each defect occurs across the whole seed space — and can drive it to zero.
//   npm run build && npm run scene:sweep -- --kind building:house --count 6 --seeds 200
import { checkStructure, buildComponentSheet } from '../packages/scene/dist/index.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const kind = arg('kind', 'building:house');
const count = Number(arg('count', '6'));
const seeds = Number(arg('seeds', '200'));
const verbose = process.argv.includes('--verbose');

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
const KINDS = ['leakedInterior', 'unreachable', 'freestandingWall', 'badDoor', 'wallJog', 'doorBlocked'];

const tally = Object.fromEntries(KINDS.map((k) => [k, { seedsHit: 0, total: 0 }]));
let cleanSeeds = 0;
const worst = [];

for (let s = 1; s <= seeds; s++) {
  const map = buildComponentSheet(kind, count, s);
  const rep = checkStructure(map);
  if (rep.clean) cleanSeeds++;
  for (const k of KINDS) { if (rep[k] > 0) { tally[k].seedsHit++; tally[k].total += rep[k]; } }
  const sev = KINDS.reduce((a, k) => a + rep[k], 0);
  if (sev > 0) worst.push({ seed: s, sev, rep });
  if (verbose && sev > 0) console.log(`  seed ${s}: ${KINDS.map((k) => `${k}=${rep[k]}`).filter((x) => !x.endsWith('=0')).join(' ')}  ${C.dim}e.g. ${rep.samples.map((x) => `${x.kind}@${x.col},${x.row}`).slice(0, 3).join(' ')}${C.reset}`);
}

console.log(`\n${C.bold}STRUCTURE SWEEP${C.reset} — ${kind} ×${count} over ${seeds} seeds (${seeds * count} buildings)\n`);
const pct = (n) => `${((n / seeds) * 100).toFixed(0)}%`;
for (const k of KINDS) {
  const t = tally[k];
  const col = t.seedsHit === 0 ? C.green : C.red;
  console.log(`  ${col}${k.padEnd(18)}${C.reset} ${String(t.seedsHit).padStart(4)} seeds (${pct(t.seedsHit).padStart(4)})  ·  ${t.total} cells total`);
}
const cleanCol = cleanSeeds === seeds ? C.green : C.yellow;
console.log(`\n  ${C.bold}CLEAN seeds:${C.reset} ${cleanCol}${cleanSeeds}/${seeds} (${pct(cleanSeeds)})${C.reset}`);

if (worst.length) {
  worst.sort((a, b) => b.sev - a.sev);
  console.log(`\n${C.dim}Worst seeds (for reproducing):${C.reset}`);
  for (const w of worst.slice(0, 5)) console.log(`  ${C.dim}seed ${w.seed} (sev ${w.sev}): ${KINDS.map((k) => `${k}=${w.rep[k]}`).join(' ')}${C.reset}`);
}

process.exit(cleanSeeds === seeds ? 0 : 1);
