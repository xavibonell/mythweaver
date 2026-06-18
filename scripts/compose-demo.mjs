/**
 * Eval harness for the NEW scene pipeline (before it's wired to /play):
 *   EstablishScene → Composer → validateComposition → buildSceneMap → validateSceneMap → ASCII.
 *
 *   node scripts/compose-demo.mjs                 # deterministic FakeSceneComposer
 *   node scripts/compose-demo.mjs gemini          # real LLM director (uses .env keys)
 *   node scripts/compose-demo.mjs gemini "a torch-lit crypt of cracked tombs" dungeon night
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const { buildSceneMap, FakeSceneComposer, LlmSceneComposer } = await import('../packages/scene/dist/index.js');
const { validateComposition, validateSceneMap } = await import('../packages/shared/dist/index.js');
const { createProvider } = await import('../packages/llm/dist/index.js');
const { TERRAINS, PROPS, CHARACTERS } = await import('../packages/scene/dist/index.js');

const provider = process.argv[2]; // undefined | gemini | anthropic | openai
const setting = process.argv[3] || 'a misty fen-village green at dusk, reed huts on stilts over black water, a crooked dock';
const biome = process.argv[4] || 'village';
const timeOfDay = process.argv[5] || 'dusk';

const establish = {
  locationId: 'loc:demo-' + biome,
  brief: { setting, biome, timeOfDay },
  fixtures: [
    { id: 'bldg:hall', kind: 'fixture', tag: 'tree_oak', anchor: 'north-edge' },
    { id: 'prop:fire', kind: 'prop', tag: 'bonfire', anchor: 'center' },
  ],
  npcs: [
    { id: 'npc:edda', name: 'Edda', look: 'a wary fisherwoman', anchor: 'near:prop:fire', visible: true },
    { id: 'npc:pell', name: 'Old Pell', look: 'a hunched villager', anchor: 'east', visible: true },
    { id: 'npc:lurk', name: 'a shape in the reeds', look: 'a lurking orc', anchor: 'waterside', visible: false },
  ],
};
const party = [
  { id: 'pc:aldric', spriteTag: 'knight', name: 'Aldric' },
  { id: 'pc:brakka', spriteTag: 'wizard', name: 'Brakka' },
  { id: 'pc:pip', spriteTag: 'rogue', name: 'Pip' },
];
let seed = 0;
for (const ch of establish.locationId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
const req = { establish, party, seed };

const composer = provider ? new LlmSceneComposer(createProvider(provider)) : new FakeSceneComposer();
const t0 = Date.now();
const comp = await composer.compose(req);
const ms = Date.now() - t0;

const cat = { tags: new Set([...TERRAINS, ...PROPS, ...CHARACTERS].map((x) => x.tag)), biomes: new Set(['dungeon', 'forest', 'cave', 'village']) };
const vc = validateComposition(comp, establish, party, cat);
const map = buildSceneMap(comp);
const vm = validateSceneMap(map, { tags: cat.tags, biomes: cat.biomes });

const TER = { grass: '.', dirt: ':', stone: '#', water: '~', wall: '▓' };
const KIND = { fixture: 'F', prop: 'o', actor: 'a' };
const grid = map.tiles.map((row) => row.map((t) => TER[t] ?? '?'));
for (const o of map.objects) {
  let ch = o.kind === 'actor' ? (o.role === 'pc' ? 'P' : o.role === 'mob' ? 'M' : 'N') : KIND[o.kind];
  if (!o.visible) ch = ch.toLowerCase();
  if (grid[o.row]) grid[o.row][o.col] = ch;
}

console.log(`\nComposer: ${provider ?? 'fake'}${provider ? ` (${ms}ms)` : ''}  |  ${comp.biome}/${comp.grammar}/${comp.lighting}  |  ${map.grid.cols}x${map.grid.rows}`);
console.log(`validateComposition: ${vc.ok ? 'OK' : 'FAIL ' + JSON.stringify(vc.violations)}`);
console.log(`validateSceneMap:    ${vm.ok ? 'OK' : 'FAIL ' + JSON.stringify(vm.violations)}`);
console.log('\n' + grid.map((row) => row.join('')).join('\n'));
console.log('\nObjects (P=party N=npc M=mob F=fixture o=prop; lowercase=hidden):');
for (const o of map.objects) console.log(`  ${o.id.padEnd(14)} ${o.tag.padEnd(10)} @${o.col},${o.row}${o.visible ? '' : ' [hidden]'} zone=${o.zone ?? '?'}`);
console.log(`ambiance: ${map.ambiance.length} items  |  legend: . grass  : dirt  # stone  ~ water  ▓ wall\n`);
