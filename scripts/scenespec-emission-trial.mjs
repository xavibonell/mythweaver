#!/usr/bin/env node
/**
 * R2 — the emission trial (Weave falsification). Can a DM reliably EMIT the SceneSpec IR? Runs a spread of
 * briefs through the real model, validates each spec with validateSceneSpec, does ONE repair round on
 * failures, and reports validity. KILL CRITERION: <90% valid after one repair → shrink the surface toward
 * menus/macros (adopt the exemplar-C posture) BEFORE building the compiler.
 *
 * Run: node --env-file=.env scripts/scenespec-emission-trial.mjs
 */
import { createProvider } from '@mythweaver/llm';
import { SCENE_RELATIONS, validateSceneSpec } from '@mythweaver/shared';

const SYSTEM = `You are MythWeaver's SCENE ARCHITECT. Turn a scene brief into a SceneSpec — a declarative REQUIREMENTS document. You describe WHAT must exist and HOW things relate; a deterministic engine owns all geometry. Output ONLY one JSON object, no prose.

SceneSpec shape:
{
  "specVersion": 1,
  "brief": "<the brief, verbatim>",
  "frame": { "grammar": "settlement|interior|wild", "entry": { "edge": "north|south|east|west", "pose": "arriving" } },
  "conditions": [ { "profile": "<name>", "value": 0..1 } ],       // atmosphere: abandonment, predawn, festive, haze, flooded…
  "features": [ { "id": "<slug>", "kind": "<dotted concept>", "geom": "network|region|point|edge-profile", "count": <n?>, "states": { "<axis>": "<value>" } } ],
  "constraints": [ { "c": "<relation>", "w": "hard|story|soft", ...refs } ],
  "tableaux": [ { "id": "<slug>", "pattern": "queue|doorway-figure|audience|procession|vigil", "focus": "<featureId>", "roles": { "<role>": { "cast": "<who>", "count": <n?>, "state": "<how?>" } } } ],
  "narrationOnly": [ "<things the engine can't render — keep them in prose>" ]
}

RELATIONS (use ONLY these; nothing else): ${SCENE_RELATIONS.join(', ')}.
  through-fabric{f} · crossable{f, at:"circulation"} · across{a,b,via} · along{a,b} · near{a,b,band:[lo,hi]} · side{a, of, dir:"left|right|north…", paces} · visible-from{a,b} · unreachable-from{a,b} · facing{a,b} · in{a, region} · at-edge-of{a, region}
  Refs (f/a/b/of/region/via) are feature ids OR the literal "PARTY" (the party's entry position).
WEIGHTS: hard = must hold (geometry) · story = the story depends on it; may degrade but the DM will be told to re-narrate (e.g. 4 shuttered vs 1 open window) · soft = nice-to-have.

RULES: every ref you write must resolve to a declared feature id or PARTY (no dangling refs). You MAY omit the object of near/facing/visible-from/in/at-edge-of — it defaults to the PARTY (or the whole scene) — but every relation needs at least a subject. Never put "across" AND "near" both hard on the same pair. Sprite tags and coordinates are FORBIDDEN — only concepts + relations. Things that can't be rendered (sounds, a bell that does NOT ring, smells) go in narrationOnly.

EXAMPLES:

Brief: "a walled market town with a temple and a blacksmith; the merchant Elara waits by the fountain"
{"specVersion":1,"brief":"a walled market town with a temple and a blacksmith; the merchant Elara waits by the fountain","frame":{"grammar":"settlement","entry":{"edge":"south","pose":"arriving"}},"features":[{"id":"temple1","kind":"building.temple","geom":"region"},{"id":"smithy1","kind":"building.smithy","geom":"region"},{"id":"plaza1","kind":"plaza","geom":"region"},{"id":"wall1","kind":"wall","geom":"network"}],"constraints":[{"c":"at-edge-of","a":"smithy1","region":"plaza1","w":"soft"}],"tableaux":[{"id":"t1","pattern":"vigil","focus":"plaza1","roles":{"figure":{"cast":"npc:elara","name":"the merchant Elara","state":"anxious"}}}]}

Brief: "a canal crossing in a plague-quiet city; four shuttered windows face you across the water, one hangs open; a hollow-eyed man sits catatonic in a doorway three paces to your right; down the canal a hooded figure ladles from a pot to a shuffling queue at a mossy shrine"
{"specVersion":1,"brief":"…","frame":{"grammar":"settlement","entry":{"edge":"south","pose":"arriving"}},"conditions":[{"profile":"abandonment","value":0.8},{"profile":"predawn"}],"features":[{"id":"canal1","kind":"waterway.canal","geom":"network"},{"id":"row1","kind":"building.house","geom":"region","count":3},{"id":"winShut","kind":"window","geom":"point","count":4,"states":{"shutter":"closed"}},{"id":"winOpen","kind":"window","geom":"point","count":1,"states":{"shutter":"open"}},{"id":"shrine1","kind":"shrine","geom":"point","states":{"upkeep":"mossy"}},{"id":"door1","kind":"doorway","geom":"point"}],"constraints":[{"c":"through-fabric","f":"canal1","w":"hard"},{"c":"crossable","f":"canal1","at":"circulation","w":"hard"},{"c":"across","a":"row1","b":"PARTY","via":"canal1","w":"hard"},{"c":"in","a":"winShut","region":"row1","w":"story"},{"c":"in","a":"winOpen","region":"row1","w":"story"},{"c":"facing","a":"winShut","b":"PARTY","w":"soft"},{"c":"along","a":"shrine1","b":"canal1","w":"story"},{"c":"side","a":"door1","of":"PARTY","dir":"right","paces":3,"w":"story"}],"tableaux":[{"id":"tQueue","macro":"shrine_ladle_service","focus":"shrine1","roles":{"officiant":{"cast":"npc:monk"},"line":{"cast":"villager","count":6,"state":"shuffling"}}},{"id":"tDoor","pattern":"doorway-figure","focus":"door1","roles":{"figure":{"cast":"npc:villager","name":"a hollow-eyed man","state":"catatonic"}}}],"narrationOnly":["a bell that should have rung does not","pale sweet smoke on the air"]}

Brief: "a torchlit crypt antechamber lined with stone sarcophagi, a sealed door at the far wall"
{"specVersion":1,"brief":"a torchlit crypt antechamber lined with stone sarcophagi, a sealed door at the far wall","frame":{"grammar":"interior","entry":{"edge":"south"}},"conditions":[{"profile":"gloom","value":0.6}],"features":[{"id":"hall1","kind":"chamber","geom":"region"},{"id":"tombs","kind":"sarcophagus","geom":"point","count":6},{"id":"door1","kind":"doorway","geom":"point","states":{"lock":"sealed"}}],"constraints":[{"c":"in","a":"tombs","region":"hall1","w":"story"},{"c":"across","a":"door1","b":"PARTY","w":"soft"}]}

Brief: "a forest clearing at night around a bonfire, wolves circling in the dark"
{"specVersion":1,"brief":"a forest clearing at night around a bonfire, wolves circling in the dark","frame":{"grammar":"wild","entry":{"edge":"south"}},"conditions":[{"profile":"night","value":0.8}],"features":[{"id":"clearing1","kind":"clearing","geom":"region"},{"id":"fire1","kind":"bonfire","geom":"point"},{"id":"wolves","kind":"wolf","geom":"point","count":5}],"constraints":[{"c":"near","a":"fire1","b":"PARTY","band":[2,5],"w":"soft"},{"c":"visible-from","a":"wolves","b":"PARTY","w":"soft"}],"tableaux":[{"id":"tCircle","pattern":"audience","focus":"fire1","roles":{"ring":{"cast":"wolf","count":5,"state":"circling"}}}]}

Now write the SceneSpec JSON for the player's brief. Output ONLY the JSON.`;

const BRIEFS = [
  'a city with a church and a blacksmith',
  'a canal crossing in a plague-quiet city; four shuttered windows face you across the water, one hangs open; a hollow-eyed man sits catatonic in a doorway three paces to your right; down the canal a hooded figure ladles from a pot to a shuffling queue at a mossy shrine; a bell that should ring does not',
  'a fishing village by the sea, boats at the docks, nets drying on frames',
  'a torchlit crypt antechamber lined with stone sarcophagi, a sealed door at the back',
  'a bustling market square at midday, stalls, a central fountain, a jostling crowd',
  'a forest clearing at night around a bonfire, wolves circling in the dark',
  'a walled town with a keep, barracks and an armory; the captain waits at the gate',
  'a mountain monastery, monks in procession toward the altar',
  'a riverside mill town, a millrace turning the wheel, a footbridge to the far bank',
  'a throne room, guards flanking the throne, petitioners waiting in a queue',
  'a swamp village on stilts over black water, huts joined by plank walkways',
  'a ruined watchtower on a sea cliff, waves crashing below',
  'a desert oasis, a caravan camped around the pool, palm trees for shade',
  'a temple plaza with a great reflecting pool, pilgrims kneeling at the water edge',
  'a goblin warren, cages, a cookfire, a captured merchant in the corner',
  'a harbor town at dawn, ships at the quay, a lighthouse on the point',
  'a snowy mountain pass, an abandoned shrine, a frozen traveler',
  'a library with rows of towering shelves, a scholar at a reading desk',
  'a plague ward, rows of cots, a physician moving among the sick',
  'a village green at dusk, a maypole, villagers dancing in a ring',
];

const provider = createProvider('anthropic', process.env.MYTHWEAVER_DM_MODEL ? { model: process.env.MYTHWEAVER_DM_MODEL } : {});
const extractJson = (t) => { const m = t.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };

let firstPass = 0, afterRepair = 0, parseFail = 0;
const relCounts = {}, condCounts = {}, features = [];
const failLines = [];

for (let i = 0; i < BRIEFS.length; i++) {
  const brief = BRIEFS[i];
  let res = await provider.complete({ system: SYSTEM, messages: [{ role: 'user', content: brief }], maxTokens: 1600 });
  let spec = extractJson(res.text ?? '');
  if (!spec) { parseFail++; failLines.push(`  ${i + 1}. PARSE-FAIL "${brief.slice(0, 40)}…"`); continue; }
  let rep = validateSceneSpec(spec);
  const ok1 = rep.ok;
  if (ok1) firstPass++;
  if (!rep.ok) {
    // one repair round: hand the violations back
    const fix = await provider.complete({ system: SYSTEM, messages: [{ role: 'user', content: brief }, { role: 'assistant', content: JSON.stringify(spec) }, { role: 'user', content: `That SceneSpec has these validation errors — fix ALL of them and output ONLY the corrected JSON:\n${rep.violations.map((x) => `- ${x.code}: ${x.message}`).join('\n')}` }], maxTokens: 1600 });
    const s2 = extractJson(fix.text ?? '');
    if (s2) { spec = s2; rep = validateSceneSpec(spec); }
  }
  if (rep.ok) afterRepair++;
  // tally
  for (const c of spec.constraints ?? []) relCounts[c.c] = (relCounts[c.c] || 0) + 1;
  for (const c of spec.conditions ?? []) condCounts[c.profile] = (condCounts[c.profile] || 0) + 1;
  features.push((spec.features ?? []).length);
  const tag = ok1 ? '✓' : rep.ok ? '~repaired' : '✗STILL-INVALID';
  if (!ok1) failLines.push(`  ${i + 1}. ${tag} "${brief.slice(0, 40)}…"${rep.ok ? '' : ' → ' + rep.violations.slice(0, 2).map((x) => x.code).join(',')}`);
}

const n = BRIEFS.length;
console.log(`\nSceneSpec EMISSION TRIAL — ${n} briefs, model ${provider.model ?? 'default'}`);
console.log(`  first-pass valid:   ${firstPass}/${n}  (${((100 * firstPass) / n).toFixed(0)}%)`);
console.log(`  valid after 1 repair: ${afterRepair}/${n}  (${((100 * afterRepair) / n).toFixed(0)}%)   [KILL if < 90%]`);
console.log(`  parse failures:     ${parseFail}`);
console.log(`  avg features/spec:  ${(features.reduce((a, b) => a + b, 0) / features.length).toFixed(1)}`);
console.log(`  relations used:     ${Object.entries(relCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.log(`  conditions used:    ${Object.entries(condCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
if (failLines.length) { console.log('  notes:'); console.log(failLines.join('\n')); }
console.log(afterRepair / n >= 0.9 ? '\n→ L0-as-primary CONFIRMED (≥90%): the SceneSpec IR is emittable. Proceed to the compiler.' : '\n→ KILL: emission < 90% — shrink the surface (menu/macros, C posture) before building the compiler.');
