// SPATIAL TRUTH R0 — falsify the derivation before building on it (docs/SPATIAL-TRUTH.md §7).
// Runs buildSpatialIndex over every frozen dev-session map + N deterministic FakeSceneComposer
// seeds and checks: (1) media cover every tag in use (unknown tags = fidelity tickets, listed);
// (2) indoor derivation sanity (roofed cells exist where buildings exist); (3) random walkable
// pairs path or are explainably blocked; (4) R0 BIT-PARITY: with swim='none', every walkable cell
// is enterable and every non-walkable cell is not (traversability == walkable[][]); (5) build <2ms.
// Also prints an ASCII overlay of the drowned-bell fixture for the human sweep.
// Run: npm run build && node scripts/spatial-falsify.mjs [--seeds 50] [--ascii]

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildSpatialIndex, findPath } from '../packages/engine/dist/index.js';
import { FakeSceneComposer, buildSceneMap } from '../packages/scene/dist/index.js';

const args = process.argv.slice(2);
const SEEDS = Number(args[args.indexOf('--seeds') + 1]) || 50;
const ASCII = args.includes('--ascii');

const maps = [];
// 1. Frozen dev-session maps (real modern-engine output, the ones live play uses).
const devDir = resolve('content/dev-sessions');
try {
  for (const f of readdirSync(devDir).filter((x) => x.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(devDir, f), 'utf8'));
    const world = d.state?.world;
    for (const [locId, m] of Object.entries(world?.locations ?? {})) maps.push({ name: `${f}:${locId}`, map: m });
  }
} catch { /* no dev sessions */ }
// 2. Deterministic $0 composer seeds across biomes.
const establish = (i) => ({
  locationId: `loc:falsify-${i}`,
  brief: { setting: 'a fen village on black water', biome: ['village', 'forest', 'cave', 'dungeon'][i % 4], timeOfDay: 'dusk' },
  fixtures: [{ id: 'prop:well', kind: 'prop', tag: 'well', anchor: 'center' }],
  npcs: [{ id: 'npc:a', name: 'A', look: 'a villager', anchor: 'in:commons', visible: true }],
});
const composer = new FakeSceneComposer();
for (let i = 0; i < SEEDS; i++) {
  const comp = await composer.compose({ establish: establish(i), party: [{ id: 'pc:x', spriteTag: 'knight', name: 'X' }], seed: i });
  maps.push({ name: `seed-${i}`, map: buildSceneMap(comp) });
}

let fail = 0;
const allUnknown = new Set();
let worstBuildMs = 0;
let pathChecks = 0, pathOk = 0, pathBlockedExplained = 0;

for (const { name, map } of maps) {
  buildSpatialIndex(map); // warm-up (JIT) — the runtime case is warm rebuilds mid-session
  const t0 = performance.now();
  const idx = buildSpatialIndex(map);
  const ms = performance.now() - t0;
  worstBuildMs = Math.max(worstBuildMs, ms);
  for (const t of idx.unknownTags) allUnknown.add(t);

  // (4) BIT-PARITY: swim='none' traversability == walkable[][] — enterability check per cell.
  const { cols, rows } = map.grid;
  let parityViolations = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const walk = map.walkable?.[r]?.[c] === true;
      const inRegion = idx.roomId[r * cols + c] !== -1;
      if (walk !== inRegion) parityViolations++;
    }
  if (parityViolations) { console.log(`✗ ${name}: ${parityViolations} parity violations (walkable[][] vs regions)`); fail++; }

  // (3) random pairs: sample 20 walkable pairs; path must succeed or blocked with a reason+frontier.
  const walkCells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (map.walkable?.[r]?.[c]) walkCells.push({ col: c, row: r });
  const pick = (i) => walkCells[(i * 2654435761) % walkCells.length]; // deterministic
  for (let i = 0; i < 20 && walkCells.length > 1; i++) {
    const a = pick(i), b = pick(i + 7919);
    if (!a || !b) continue;
    pathChecks++;
    const res = findPath(idx, a, b, { speedFt: 30, swim: 'none' });
    if (res.ok) pathOk++;
    else if (res.blockedBy) pathBlockedExplained++;
    else { console.log(`✗ ${name}: unexplained path failure (${a.col},${a.row})→(${b.col},${b.row})`); fail++; }
  }

  // (2) roof sanity: buildings with roofs must produce SOME indoor cells.
  if ((map.roofs?.length ?? 0) > 0 && idx.roofAt.size === 0) {
    console.log(`✗ ${name}: ${map.roofs.length} roof buildings but ZERO roofed cells derived`);
    fail++;
  }

  if (ms > 2) { console.log(`✗ ${name}: build ${ms.toFixed(1)}ms (>2ms)`); fail++; }
}

// ASCII overlay for the human sweep (the drowned-bell shore).
if (ASCII) {
  const target = maps.find((m) => m.name.includes('the-drowned-bell'));
  if (target) {
    const { map } = target;
    const idx = buildSpatialIndex(map);
    const { cols, rows } = map.grid;
    const CH = ['.', ',', '~', '≈', '#', ' ']; // ground/difficult/shallow/deep/wall/void
    const actors = new Map(map.objects.filter((o) => o.kind === 'actor' && o.visible !== false).map((o) => [o.row * cols + o.col, o.role === 'pc' ? '@' : o.role === 'mob' ? 'M' : 'n']));
    console.log(`\nASCII sweep — ${target.name} (@ pc, n npc, M mob, R roofed, . ground , difficult ~ shallow ≈ deep # wall)`);
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c;
        line += actors.get(k) ?? (idx.roofAt.has(k) ? 'R' : CH[idx.medium[k]]);
      }
      console.log(line);
    }
  }
}

console.log(`\nR0 REPORT — ${maps.length} maps (${SEEDS} seeds + ${maps.length - SEEDS} frozen)`);
console.log(`  parity: ${fail === 0 ? 'CLEAN' : 'violations above'}`);
console.log(`  paths: ${pathChecks} sampled → ${pathOk} routed, ${pathBlockedExplained} blocked-with-reason, ${pathChecks - pathOk - pathBlockedExplained} unexplained`);
console.log(`  unknown terrain tags (fidelity tickets): ${allUnknown.size ? [...allUnknown].join(', ') : 'none'}`);
console.log(`  worst build: ${worstBuildMs.toFixed(2)}ms (gate: <2ms)`);
console.log(fail === 0 ? '\nR0 GATE: PASS' : `\nR0 GATE: FAIL (${fail} findings)`);
process.exit(fail === 0 ? 0 : 1);
