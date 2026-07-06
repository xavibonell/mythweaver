// CREDIBILITY SWEEP (Weave fidelity flywheel) — render standard SCENE archetypes headless, then run the
// vision judge over each with the TOWN rubric (which includes a `featureCredibility` lens) so the question
// "does the mountain read as a mountain, the dock as a dock, is anything incongruous?" becomes a MEASURABLE
// score instead of a hunch. This is the guardrail against shipping tasteless scenes.
//
// CRUCIAL: judging the whole 900px town is nearly blind to a 40px dock — asset-level defects (a boat that
// reads as a plank, a rope-net "dock") survive. So every frontier FEATURE is ALSO cropped and 4× upscaled
// and judged on its own, at a scale where the judge can actually see the boat/mine. That feature-zoom pass
// is the fix for "the judge didn't catch the bad boats."
//
//   npm run build && node scripts/credibility-sweep.mjs            # judge the standard scenes + feature zooms
//   node scripts/credibility-sweep.mjs --only grim-port            # one scene
//   node scripts/credibility-sweep.mjs --no-judge                  # just render the full + feature-crop PNGs (no API $)
// Real Anthropic vision calls (~3 lenses/scene + 3/feature-crop) unless --no-judge.
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim(); }
} catch { /* no .env */ }

const { runProgram, renderSceneMapToPng } = await import('@mythweaver/scene');
const { AnthropicProvider } = await import('@mythweaver/llm');
const { runVisualJudge } = await import('../apps/server/dist/scene-eval/visual-judge.js');

const assetsRoot = new URL('../apps/web/public', import.meta.url).pathname;
const capDir = new URL('../apps/server/src/scene-eval/captures/', import.meta.url).pathname;
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const only = arg('only');
const noJudge = process.argv.includes('--no-judge');
const TILE = 16;

const town = (over) => ({ cols: 58, rows: 38, seed: 5, base: 'grass', biome: 'village', lighting: 'day', grammar: 'town-square', theme: 'village', outdoor: true, ...over });
const bldg = (...t) => t.map((type) => ({ type }));
// Standard scenes: the hard case (all frontier features) + the exact FAILURE case the user hit (a grim,
// foggy fishing port) + controls. Add a scene here the moment a defect slips through in the wild.
const SCENES = [
  { name: 'coastal-mine', subject: 'a frontier town where mountains meet the sea, with a fishing port and a cliff mine',
    contents: { buildings: bldg('tavern', 'smithy', 'shop', 'house', 'house'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], coast: true, mountain: true, port: true, mine: true, character: 'mining', entranceSide: 'south' } },
  { name: 'grim-port', lighting: 'fog', subject: 'a grim, fog-bound fishing village on a drowned coast — a plank dock with moored boats',
    contents: { buildings: bldg('tavern', 'shop', 'house', 'house'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], coast: true, port: true, character: 'grim', entranceSide: 'west' } },
  { name: 'mountain-village', subject: 'a small village at the foot of a mountain',
    contents: { buildings: bldg('tavern', 'shop', 'house', 'house', 'temple'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], mountain: true, character: 'civic', entranceSide: 'south' } },
  { name: 'plain-village', subject: 'a plain inland village',
    contents: { buildings: bldg('tavern', 'shop', 'smithy', 'house', 'house', 'house'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], character: 'civic', entranceSide: 'south' } },
];

// ── Feature crop: locate a frontier FEATURE (port wharf / mine mouth) and return its tile bbox. ──
function featureBBox(map, kind) {
  const tiles = map.tiles; const things = [...(map.ambiance ?? []), ...(map.objects ?? [])];
  const cells = [];
  if (kind === 'port') {
    for (let r = 0; r < tiles.length; r++) for (let c = 0; c < tiles[r].length; c++) {
      if (tiles[r][c] !== 'wood_floor') continue;
      let nearWater = false; // wharf planks touch water; building floors don't → isolates the dock
      for (let dr = -1; dr <= 1 && !nearWater; dr++) for (let dc = -1; dc <= 1; dc++) { const t = tiles[r + dr]?.[c + dc]; if (t && t.startsWith('water')) { nearWater = true; break; } }
      if (nearWater) cells.push([c, r]);
    }
    for (const a of things) if (['boat', 'boat_sail', 'boat_cargo', 'piling', 'rope_coil'].includes(a.tag)) cells.push([a.col, a.row]);
  } else {
    for (const a of things) if (['mine_entrance', 'ore_vein'].includes(a.tag)) cells.push([a.col, a.row]);
  }
  if (cells.length < 2) return null;
  const xs = cells.map((p) => p[0]), ys = cells.map((p) => p[1]);
  return { x0: Math.min(...xs) - 3, y0: Math.min(...ys) - 4, x1: Math.max(...xs) + 4, y1: Math.max(...ys) + 3 };
}

// ── Crop the full render to a bbox and nearest-neighbour upscale, so the judge sees the feature big. ──
function cropUpscale(pngBuf, bbox, scale) {
  const src = PNG.sync.read(pngBuf);
  const x0 = Math.max(0, bbox.x0 * TILE), y0 = Math.max(0, bbox.y0 * TILE);
  const x1 = Math.min(src.width, bbox.x1 * TILE), y1 = Math.min(src.height, bbox.y1 * TILE);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const out = new PNG({ width: w * scale, height: h * scale });
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const sx = x0 + Math.floor(x / scale), sy = y0 + Math.floor(y / scale);
    const si = (sy * src.width + sx) << 2, di = (y * out.width + x) << 2;
    out.data[di] = src.data[si]; out.data[di + 1] = src.data[si + 1]; out.data[di + 2] = src.data[si + 2]; out.data[di + 3] = 255;
  }
  return PNG.sync.write(out);
}

const C = { b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', gray: '\x1b[90m', r: '\x1b[0m' };
const bar = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(5 - Math.round(n));
const llm = noJudge ? null : new AnthropicProvider({ retries: 5, timeoutMs: 90_000 });

const results = [];
const featureReps = [];
for (const sc of SCENES) {
  if (only && sc.name !== only) continue;
  const map = runProgram(town({ locationId: `cred-${sc.name}`, lighting: sc.lighting ?? 'day', ops: [{ op: 'archetype', kind: 'town', contents: sc.contents }] }));
  const png = renderSceneMapToPng(map, { assetsRoot });
  const path = `${capDir}credibility-${sc.name}.png`;
  writeFileSync(path, png);
  // FEATURE ZOOM — crop + 4× upscale each frontier feature so the judge inspects the asset, not a thumbnail.
  const crops = [];
  for (const kind of ['port', 'mine']) {
    if (!sc.contents[kind]) continue;
    const bbox = featureBBox(map, kind); if (!bbox) { process.stdout.write(`${C.yel}  · no ${kind} feature found to crop in ${sc.name}${C.r}\n`); continue; }
    const cpath = `${capDir}credibility-${sc.name}-${kind}.png`;
    writeFileSync(cpath, cropUpscale(png, bbox, 4));
    crops.push({ kind, cpath });
  }
  if (noJudge) { process.stdout.write(`${C.dim}rendered ${sc.name} + ${crops.length} feature crop(s) (no judge)${C.r}\n`); results.push({ sc, rep: null, path }); continue; }
  process.stdout.write(`${C.dim}judging ${sc.name} …${C.r}\n`);
  const rep = await runVisualJudge(llm, { imagePath: path, subject: sc.subject, tilePx: 16, rubric: 'town' });
  results.push({ sc, rep, path });
  for (const { kind, cpath } of crops) {
    const subj = kind === 'port'
      ? `a 4× ZOOMED close-up of ONE thing: the town's fishing DOCK. Judge only whether each object reads clearly as what it is — the pier as WOODEN PLANKS (not a rope net), the boats as BOATS (hull, not a brown smear), the posts as mooring pilings. Crudeness or wrong-asset = a featureCredibility defect.`
      : `a 4× ZOOMED close-up of ONE thing: the MINE entrance set into a cliff. Judge only whether it reads as a real carved/timbered mine mouth (not a generic stairs or door icon).`;
    const crep = await runVisualJudge(llm, { imagePath: cpath, subject: subj, tilePx: 64, rubric: 'town' });
    featureReps.push({ name: `${sc.name}/${kind}`, rep: crep, path: cpath });
  }
}

if (noJudge) { console.log(`\n${C.dim}renders → apps/server/src/scene-eval/captures/credibility-* (dry run, no scores)${C.r}`); process.exit(0); }

console.log(`\n${C.b}CREDIBILITY SWEEP${C.r} — town rubric (feature credibility + composition)\n`);
const dims = results.find((r) => r.rep)?.rep ? Object.keys(results.find((r) => r.rep).rep.scores) : [];
process.stdout.write(`${'scene'.padEnd(18)}`);
for (const d of dims) process.stdout.write(`${C.dim}${d.slice(0, 9).padEnd(11)}${C.r}`);
console.log(`${C.dim}mean${C.r}`);
for (const { sc, rep } of results) {
  if (!rep) continue;
  process.stdout.write(`${sc.name.padEnd(18)}`);
  for (const d of dims) { const v = rep.scores[d]; const col = v >= 4 ? C.grn : v >= 3 ? C.yel : C.red; process.stdout.write(`${col}${String(v).padEnd(11)}${C.r}`); }
  console.log(`${C.b}${rep.meanScore}${C.r}`);
}

console.log(`\n${C.b}FEATURE ZOOM${C.r} — the asset-level guardrail (4× crops the whole-town view can't see)\n`);
for (const { name, rep } of featureReps) {
  const cred = rep.scores.featureCredibility;
  const col = cred >= 4 ? C.grn : cred >= 3 ? C.yel : C.red;
  console.log(`${C.b}${name.padEnd(22)}${C.r} featureCredibility ${col}${bar(cred)} ${cred}${C.r}  ${C.dim}(mean ${rep.meanScore}, ${rep.defects.length} defects)${C.r}`);
  for (const d of rep.defects.filter((x) => x.category === 'featureCredibility' || x.severity === 'critical').slice(0, 4))
    console.log(`  ${d.severity === 'critical' ? C.red : C.yel}${d.severity}${C.r} ${C.dim}${d.unit}/${d.region}${C.r} ${d.detail}`);
}

writeFileSync(`${capDir}credibility-sweep.json`, JSON.stringify({
  scenes: results.filter((r) => r.rep).map((r) => ({ name: r.sc.name, scores: r.rep.scores, mean: r.rep.meanScore, defects: r.rep.defects })),
  features: featureReps.map((r) => ({ name: r.name, scores: r.rep.scores, mean: r.rep.meanScore, defects: r.rep.defects })),
}, null, 2));
console.log(`\n${C.dim}renders + report → apps/server/src/scene-eval/captures/credibility-*${C.r}`);
