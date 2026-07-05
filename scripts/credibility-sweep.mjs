// CREDIBILITY SWEEP (Weave fidelity flywheel) — render standard SCENE archetypes headless, then run the
// vision judge over each with the TOWN rubric (which now includes a `featureCredibility` lens) so the
// question "does the mountain read as a mountain, the dock as a dock, is anything incongruous?" becomes
// a MEASURABLE score instead of a hunch. This is the guardrail against shipping tasteless scenes.
//
//   npm run build && node scripts/credibility-sweep.mjs            # judge the standard scenes
//   node scripts/credibility-sweep.mjs --only coastal-mine         # one scene
// Real Anthropic vision calls (~3 lenses/scene).
import { readFileSync, writeFileSync } from 'node:fs';

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

const town = (over) => ({ cols: 58, rows: 38, seed: 5, base: 'grass', biome: 'village', lighting: 'day', grammar: 'town-square', theme: 'village', outdoor: true, ...over });
const bldg = (...t) => t.map((type) => ({ type }));
// Standard scenes: the hard case (all frontier features) + controls.
const SCENES = [
  { name: 'coastal-mine', subject: 'a frontier town where mountains meet the sea, with a fishing port and a cliff mine',
    contents: { buildings: bldg('tavern', 'smithy', 'shop', 'house', 'house'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], coast: true, mountain: true, port: true, mine: true, character: 'mining', entranceSide: 'south' } },
  { name: 'mountain-village', subject: 'a small village at the foot of a mountain',
    contents: { buildings: bldg('tavern', 'shop', 'house', 'house', 'temple'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], mountain: true, character: 'civic', entranceSide: 'south' } },
  { name: 'plain-village', subject: 'a plain inland village',
    contents: { buildings: bldg('tavern', 'shop', 'smithy', 'house', 'house', 'house'), landmarks: [], npcs: [{ tag: 'villager' }], mobs: [], character: 'civic', entranceSide: 'south' } },
];

const C = { b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', yel: '\x1b[33m', grn: '\x1b[32m', gray: '\x1b[90m', r: '\x1b[0m' };
const bar = (n) => '█'.repeat(Math.round(n)) + '░'.repeat(5 - Math.round(n));
const llm = new AnthropicProvider({ retries: 5, timeoutMs: 90_000 });

const results = [];
for (const sc of SCENES) {
  if (only && sc.name !== only) continue;
  const map = runProgram(town({ locationId: `cred-${sc.name}`, ops: [{ op: 'archetype', kind: 'town', contents: sc.contents }] }));
  const png = renderSceneMapToPng(map, { assetsRoot });
  const path = `${capDir}credibility-${sc.name}.png`;
  writeFileSync(path, png);
  process.stdout.write(`${C.dim}judging ${sc.name} …${C.r}\n`);
  const rep = await runVisualJudge(llm, { imagePath: path, subject: sc.subject, tilePx: 16, rubric: 'town' });
  results.push({ sc, rep, path });
}

console.log(`\n${C.b}CREDIBILITY SWEEP${C.r} — town rubric (feature credibility + composition)\n`);
const dims = results[0]?.rep ? Object.keys(results[0].rep.scores) : [];
const w = 20;
process.stdout.write(`${'scene'.padEnd(18)}`);
for (const d of dims) process.stdout.write(`${C.dim}${d.slice(0, 9).padEnd(11)}${C.r}`);
console.log(`${C.dim}mean${C.r}`);
for (const { sc, rep } of results) {
  process.stdout.write(`${sc.name.padEnd(18)}`);
  for (const d of dims) { const v = rep.scores[d]; const col = v >= 4 ? C.grn : v >= 3 ? C.yel : C.red; process.stdout.write(`${col}${String(v).padEnd(11)}${C.r}`); }
  console.log(`${C.b}${rep.meanScore}${C.r}`);
}
console.log('');
for (const { sc, rep } of results) {
  const cred = rep.scores.featureCredibility;
  console.log(`${C.b}${sc.name}${C.r}  featureCredibility ${bar(cred)} ${cred}  ${C.dim}(${rep.defects.length} defects)${C.r}`);
  for (const d of rep.defects.filter((x) => x.category === 'featureCredibility' || x.severity === 'critical').slice(0, 6))
    console.log(`  ${d.severity === 'critical' ? C.red : C.yel}${d.severity}${C.r} ${C.dim}${d.unit}/${d.region}${C.r} ${d.detail}`);
}
writeFileSync(`${capDir}credibility-sweep.json`, JSON.stringify(results.map((r) => ({ name: r.sc.name, scores: r.rep.scores, mean: r.rep.meanScore, defects: r.rep.defects })), null, 2));
console.log(`\n${C.dim}renders + report → apps/server/src/scene-eval/captures/credibility-*${C.r}`);
