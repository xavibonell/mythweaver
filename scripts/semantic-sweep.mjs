// Semantic-invariant sweep — the deterministic, $0 inner loop for "does it read as its TYPE?" (pairs with
// structure-sweep, which proves geometry). Builds a building type over N seeds and tallies the semantic
// defect classes (see semantic-check.ts), so we can drive each type to 100% the way we did structure.
//   npm run build && npm run scene:sweep:semantics -- --kind building:temple --seeds 200
import { checkSemantics, buildComponentSheet, BUILDING_SEMANTICS } from '../packages/scene/dist/index.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const only = arg('kind', '');
const count = Number(arg('count', '6'));
const seeds = Number(arg('seeds', '200'));
const verbose = process.argv.includes('--verbose');

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
const KINDS = ['missingFocal', 'focalNotProminent', 'understocked', 'keeperOffStation'];
// Only types with a declared spec are meaningful; the rest are vacuously clean.
const types = Object.keys(BUILDING_SEMANTICS);
const targets = only ? [only.replace(/^building:/, '')] : types;

let anyDirty = false;
for (const type of targets) {
  if (!BUILDING_SEMANTICS[type]) { console.log(`${C.yellow}${type}: no semantic spec yet (skipped)${C.reset}`); continue; }
  const kind = `building:${type}`;
  const tally = Object.fromEntries(KINDS.map((k) => [k, { seedsHit: 0, total: 0 }]));
  let cleanSeeds = 0, buildings = 0;
  const worst = [];
  for (let s = 1; s <= seeds; s++) {
    const rep = checkSemantics(buildComponentSheet(kind, count, s), type);
    buildings += rep.buildings;
    if (rep.clean) cleanSeeds++;
    for (const k of KINDS) if (rep[k] > 0) { tally[k].seedsHit++; tally[k].total += rep[k]; }
    const sev = KINDS.reduce((a, k) => a + rep[k], 0);
    if (sev > 0) worst.push({ seed: s, sev, rep });
    if (verbose && sev > 0) console.log(`  seed ${s}: ${KINDS.map((k) => `${k}=${rep[k]}`).filter((x) => !x.endsWith('=0')).join(' ')}  ${C.dim}e.g. ${rep.samples.map((x) => `${x.kind}@${x.col},${x.row}`).slice(0, 3).join(' ')}${C.reset}`);
  }
  console.log(`\n${C.bold}SEMANTIC SWEEP${C.reset} — ${kind} ×${count} over ${seeds} seeds (${buildings} buildings)\n`);
  const pct = (n) => `${((n / seeds) * 100).toFixed(0)}%`;
  for (const k of KINDS) { const t = tally[k]; const col = t.seedsHit === 0 ? C.green : C.red; console.log(`  ${col}${k.padEnd(18)}${C.reset} ${String(t.seedsHit).padStart(4)} seeds (${pct(t.seedsHit).padStart(4)})  ·  ${t.total} buildings`); }
  const cleanCol = cleanSeeds === seeds ? C.green : C.yellow;
  console.log(`\n  ${C.bold}CLEAN seeds:${C.reset} ${cleanCol}${cleanSeeds}/${seeds} (${pct(cleanSeeds)})${C.reset}`);
  if (worst.length) { worst.sort((a, b) => b.sev - a.sev); console.log(`\n${C.dim}Worst seeds:${C.reset}`); for (const w of worst.slice(0, 5)) console.log(`  ${C.dim}seed ${w.seed} (sev ${w.sev}): ${KINDS.map((k) => `${k}=${w.rep[k]}`).join(' ')}${C.reset}`); }
  if (cleanSeeds !== seeds) anyDirty = true;
}

process.exit(anyDirty ? 1 : 0);
