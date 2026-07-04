#!/usr/bin/env node
/**
 * P0 coherence sweep — the falsifier for the coherence-layer strategy. Runs the two anchor probes
 * (doorApproachBlocked = fountain-in-doorway class, bedByBar = beds-at-the-bar class) over the seed
 * space of BOTH city blueprint engines and prints the real failure rates. This number decides whether
 * the Contract Layer (P1+) proceeds, and it becomes the permanent gate the crank drives to zero.
 *
 * Usage: npm run build && node scripts/coherence-sweep.mjs [--seeds 200]
 */
import { checkCoherence, realizeCityBsp, realizeCityMesh } from '@mythweaver/scene';

const SEEDS = Number(process.argv[process.argv.indexOf('--seeds') + 1]) || 200;
const ENGINES = [
  ['orthogonal', realizeCityBsp],
  ['organic', realizeCityMesh],
];

console.log(`coherence sweep — ${SEEDS} seeds × ${ENGINES.length} engines (nPatches=15, walled)\n`);
const grand = { maps: 0, dirtyMaps: 0, doors: 0, blocked: 0, beds: 0, far: 0 };
for (const [name, realize] of ENGINES) {
  const agg = { maps: 0, dirtyMaps: 0, doors: 0, blocked: 0, beds: 0, far: 0, samples: [] };
  const t0 = Date.now();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rep = checkCoherence(realize(seed, { nPatches: 15 }));
    agg.maps++; agg.doors += rep.doors; agg.blocked += rep.doorApproachBlocked; agg.beds += rep.bedByBar; agg.far += rep.doorStreetFar;
    if (!rep.clean) {
      agg.dirtyMaps++;
      if (agg.samples.length < 8) for (const s of rep.samples) if (agg.samples.length < 8) agg.samples.push({ seed, ...s });
    }
  }
  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '—');
  console.log(`[${name}]  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  dirty maps          ${agg.dirtyMaps}/${agg.maps}  (${pct(agg.dirtyMaps, agg.maps)})`);
  console.log(`  doorApproachBlocked ${agg.blocked}/${agg.doors} doors  (${pct(agg.blocked, agg.doors)})`);
  console.log(`  bedByBar            ${agg.beds}`);
  console.log(`  doorStreetFar       ${agg.far}/${agg.doors} doors  (${pct(agg.far, agg.doors)})  [metric, not gated]`);
  if (agg.samples.length) console.log(`  samples: ${agg.samples.map((s) => `s${s.seed} ${s.kind}@${s.col},${s.row}`).join(' · ')}`);
  console.log();
  grand.maps += agg.maps; grand.dirtyMaps += agg.dirtyMaps; grand.doors += agg.doors; grand.blocked += agg.blocked; grand.beds += agg.beds; grand.far += agg.far;
}
const rate = grand.maps ? (100 * grand.dirtyMaps) / grand.maps : 0;
console.log(`TOTAL: ${grand.dirtyMaps}/${grand.maps} dirty maps (${rate.toFixed(1)}%) · ${grand.blocked} blocked doors · ${grand.beds} beds-by-bar`);
console.log(rate < 2 ? '→ KILL CRITERION MET (<2%): stop and re-diagnose before building the layer.' : '→ real incoherence confirmed: proceed to P1 (claims grid).');
