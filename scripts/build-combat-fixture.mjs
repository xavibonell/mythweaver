#!/usr/bin/env node
/**
 * BUILD THE COMBAT DEV-SESSION — a prerendered campaign that opens IN a fight.
 *
 * The peaceful fixtures (oakhollow-green, the-drowned-bell) are for talking; testing combat from one
 * costs a scene of walking before a single blow lands. This builds the opposite: load it and the very
 * next thing you type is an attack.
 *
 * It drives the REAL machinery rather than hand-writing a state blob, because a hand-built fixture
 * lies — combatants without map tokens, tokens without stat blocks, a party staged in a wall. So:
 * compose an arc whose first beat IS the ambush → render it → let the DM stage and start the fight →
 * verify the result is actually playable → freeze.
 *
 * Re-runnable by design: it OVERWRITES its slug, so tweaking means editing the knobs below and
 * running it again. Nothing to clean up by hand.
 *
 *   node scripts/build-combat-fixture.mjs                 # build/replace the fixture
 *   node scripts/build-combat-fixture.mjs --slug my-fight # a different slug
 *   node scripts/build-combat-fixture.mjs --check         # just inspect the existing fixture
 *
 * Needs the backend running (npm run dev:server / preview 'server') and an ANTHROPIC/OPENAI key.
 * Costs roughly $0.20-0.40: one arc composition, one scene render, two or three turns.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SERVER = process.env.MYTHWEAVER_SERVER ?? 'http://localhost:6984';
const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const SLUG = arg('slug', 'roadside-ambush');
const TITLE = arg('title', 'Roadside ambush — 3 bandits, initiative live (combat test)');
const CHECK_ONLY = args.includes('--check');

// ---- THE KNOBS (tweak these, re-run) --------------------------------------------------------------
const THEME =
  'A short, punchy roadside ambush. The party is walking a forest road at dusk when bandits burst from ' +
  'the ferns — no mystery, no build-up, the fight is ON in the first breath. Beat 1 IS the ambush and ' +
  'nothing else; later beats deal with the aftermath (the survivor talks, the camp is found).';
const CONSTRAINTS = [
  'Beat 1 opens mid-ambush: the enemies are already visible, already hostile, already closing.',
  'Beat 1 uses exactly three weak humanoid enemies (bandits or goblins) — a fight three level-1 characters can win in a few rounds.',
  'The ambush site is an open forest road: clear ground to fight on, ferns and trunks for cover, no water and no buildings.',
  'No NPC ally is present in beat 1. Nobody to talk to — only enemies.',
];
// The line that makes the DM stage the fight on the map (startEncounter + spawn the tokens).
const TRIGGER_LINE = 'We draw steel as they come — where exactly are they, and how close?';
const PARTY = [{ role: 'fighter', name: 'Aldric' }, { role: 'wizard', name: 'Elara' }, { role: 'rogue', name: 'Pip' }];
// ---------------------------------------------------------------------------------------------------

const post = async (path, body, headers = {}, ms = 420000) => {
  const res = await fetch(`${SERVER}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const get = async (path, headers = {}) => {
  const res = await fetch(`${SERVER}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
};
/**
 * Keep ONLY the fight: the party and the actual combatants. Everything else the scene realizer staged
 * (ambient wanderers, and a second set of bandit props for the same three bandits) is scenery that
 * lies — in a combat fixture every humanoid on screen should be something you can actually swing at.
 * Props, terrain and ambiance are untouched; this only prunes ACTORS.
 */
function stripTheCrowd(path) {
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const st = file.state;
  const map = st.world?.locations?.[st.world.currentLocationId];
  if (!map) return [];
  const keep = new Set([...Object.keys(st.combatants ?? {})]);
  const dropped = [];
  map.objects = map.objects.filter((o) => {
    if (o.kind !== 'actor') return true;
    if (o.role === 'pc' || keep.has(o.id)) return true;
    dropped.push(`${o.id}${o.name ? ` (${o.name})` : ''}`);
    return false;
  });
  if (dropped.length) writeFileSync(path, JSON.stringify(file));
  return dropped;
}

const ft = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row)) * 5;

/** Is this fixture actually ready to fight in? The checks a hand-built blob would silently fail. */
function audit(state) {
  const map = state.world?.locations?.[state.world.currentLocationId];
  const objects = map?.objects ?? [];
  const pcs = objects.filter((o) => o.role === 'pc');
  const combatants = Object.values(state.combatants ?? {});
  const foes = combatants.filter((c) => c.kind === 'npc' && !c.downed);
  const tokenFor = (c) => objects.find((o) => o.id === c.id || o.name === c.name);
  const placed = foes.filter((c) => tokenFor(c));
  const gaps = [];
  if (!map) gaps.push('no rendered map — the fixture would cost a render on load');
  if (pcs.length < 2) gaps.push(`only ${pcs.length} PC token(s) on the map`);
  if (!foes.length) gaps.push('no living enemy combatants — nothing to fight');
  if (placed.length !== foes.length) gaps.push(`${foes.length - placed.length} enemy combatant(s) have NO map token (invisible to the table, unreachable by the reach gate)`);
  const order = state.combat?.order ?? [];
  if (!order.length) gaps.push('combat not started (no initiative order)');
  const dists = placed.map((c) => {
    const t = tokenFor(c);
    return { name: c.name, hp: `${c.currentHitPoints}/${c.maxHitPoints}`, ac: c.armorClass, ft: Math.min(...pcs.map((p) => ft(p, t))) };
  });
  if (dists.length && Math.min(...dists.map((d) => d.ft)) > 60) gaps.push('every enemy is >60 ft away — the party spends the first rounds walking');
  const active = order[state.combat?.turnIndex ?? 0];
  const activeC = combatants.find((c) => c.id === active);
  if (activeC && activeC.kind !== 'pc') gaps.push(`it is ${activeC.name}'s turn, not a player's — the fixture opens on a monster acting`);
  return { pcs: pcs.length, foes: dists, order: order.length, active: activeC?.name, gaps };
}

const report = (a) => {
  console.log(`\n  party tokens : ${a.pcs}`);
  console.log(`  initiative   : ${a.order} in order · active = ${a.active ?? '(none)'}`);
  for (const d of a.foes) console.log(`  enemy        : ${d.name} — ${d.hp} HP, AC ${d.ac}, ${d.ft} ft from the nearest PC`);
  if (a.gaps.length) { console.log('\n  NOT READY:'); for (const g of a.gaps) console.log(`   ! ${g}`); }
  else console.log('\n  READY — load it and swing.');
};

async function main() {
  if (CHECK_ONLY) {
    const path = `content/dev-sessions/${SLUG}.json`;
    if (!existsSync(path)) { console.error(`no fixture at ${path}`); process.exit(1); }
    console.log(`\nAUDIT ${path}`);
    report(audit(JSON.parse(readFileSync(path, 'utf8')).state));
    return;
  }

  console.log(`\n① composing an arc that OPENS in a fight …`);
  const gen = await post('/dm/lab/generate-arc', { theme: THEME, constraints: CONSTRAINTS, lengthBeats: 3, party: PARTY, tone: 'grounded' });
  const arc = gen.arc;
  const beats = Object.entries(arc.adventure?.scenes ?? {});
  console.log(`   "${arc.blueprint?.premise?.slice(0, 90) ?? '?'}…"  ($${gen.costUsd?.toFixed(3) ?? '?'})`);
  console.log(`   beat 1 = ${beats[0]?.[1]?.title}`);
  const enc = (arc.encounters ?? []).find((e) => e.sceneId === beats[0]?.[0]);
  console.log(`   beat-1 encounter: ${enc ? enc.monsters.map((m) => `${m.count}× ${m.statBlockId}`).join(', ') : 'NONE — the fight would have to be improvised'}`);

  console.log(`\n② starting the session and RENDERING the ambush site …`);
  const session = await post('/dm/lab/session', { generatedArc: arc, sceneEngine: 'modern', startScene: beats[0]?.[0] });
  const { sessionId, dmKey } = session;
  const dm = { 'x-dm-key': dmKey };

  console.log(`\n③ opening narration …`);
  const open = await post(`/dm/lab/session/${sessionId}/turn`, { open: true }, dm);
  console.log(`   ${(open.turn?.narration ?? '').slice(0, 220)}…`);

  console.log(`\n④ staging the fight (the DM spawns the tokens and rolls initiative) …`);
  const trig = await post(`/dm/lab/session/${sessionId}/turn`, { say: TRIGGER_LINE, as: 'Aldric' }, dm);
  console.log(`   ${(trig.turn?.narration ?? '').slice(0, 220)}…`);
  console.log(`   tools: ${(trig.turn?.trace?.toolCalls ?? []).map((t) => t.name).join(', ') || '(none)'}`);

  // AUDIT THE ARTIFACT, not the live session: /view carries the map but not the combatants, and the
  // thing that matters is the file a player will actually load. So freeze first, then judge the file.
  const path = `content/dev-sessions/${SLUG}.json`;
  const freezeAndRead = async () => {
    await post(`/dm/lab/session/${sessionId}/freeze?key=${dmKey}`, { slug: SLUG, title: TITLE });
    const dropped = stripTheCrowd(path);
    if (dropped.length) console.log(`   stripped ${dropped.length} bystander token(s): ${dropped.slice(0, 6).join(', ')}${dropped.length > 6 ? ' …' : ''}`);
    return JSON.parse(readFileSync(path, 'utf8')).state;
  };
  let a = audit(await freezeAndRead());

  // One nudge if the DM described the ambush without putting the enemies on the board.
  if (a.gaps.some((g) => g.includes('no living enemy') || g.includes('NO map token') || g.includes('not started'))) {
    console.log(`\n④b the fight is not on the board yet — nudging once …`);
    const push = await post(`/dm/lab/session/${sessionId}/turn`, { say: 'I charge the nearest one and swing!', as: 'Aldric' }, dm);
    console.log(`   tools: ${(push.turn?.trace?.toolCalls ?? []).map((t) => t.name).join(', ') || '(none)'}`);
    a = audit(await freezeAndRead());
  }

  // SETTLE THE PROSE AGAINST THE BOARD — on a session RELOADED FROM THE STRIPPED FIXTURE.
  //
  // Order matters here, and the first attempt got it wrong: stripping only rewrites the file, so a
  // settle turn run against the ORIGINAL session still saw the bystanders and dutifully narrated "six
  // smaller rogues in the ferns" that the fixture no longer contains. Reloading first means the DM
  // describes exactly the board a player will see — and it doubles as proof the fixture round-trips.
  if (!a.gaps.length) {
    console.log(`\n④c settling the narration against the CLEANED board …`);
    const re = await post('/dm/lab/session', { frozenSession: SLUG });
    const reDm = { 'x-dm-key': re.dmKey };
    const settle = await post(`/dm/lab/session/${re.sessionId}/turn`, { say: 'Call it out — where is each of them, right now?', as: 'Aldric' }, reDm);
    console.log(`   ${(settle.turn?.narration ?? '').slice(0, 260)}…`);
    await post(`/dm/lab/session/${re.sessionId}/freeze?key=${re.dmKey}`, { slug: SLUG, title: TITLE });
    const dropped = stripTheCrowd(path);
    if (dropped.length) console.log(`   (stripped ${dropped.length} more)`);
    a = audit(JSON.parse(readFileSync(path, 'utf8')).state);
  }

  console.log(`\n⑤ audit of ${path} (the artifact players load):`);
  report(a);
  if (a.gaps.length) {
    console.log(`\n   The fixture is WRITTEN but NOT ready. Tweak the knobs at the top and re-run — it overwrites.`);
    process.exit(2);
  }
  console.log(`\n⑥ frozen and sound.`);

  console.log(`\n⑦ reloading it cold — proving it costs nothing and comes up fighting …`);
  const t0 = Date.now();
  const fresh = await post('/dm/lab/session', { frozenSession: SLUG });
  const view = await get(`/dm/lab/session/${fresh.sessionId}/view`, { 'x-dm-key': fresh.dmKey });
  const tokens = (view.scene?.map?.objects ?? []).filter((o) => o.kind === 'actor');
  console.log(`   loaded in ${Date.now() - t0} ms for $${(fresh.totalCostUsd ?? 0).toFixed(3)} · ${tokens.length} actors on a pre-rendered map`);
  console.log(`\n   play it: http://localhost:6985/dm?session=${fresh.sessionId}`);
  console.log(`   or pick "${SLUG}" from the DM Lab's prerendered list.\n`);
}

main().catch((e) => { console.error(`\nfailed: ${e.message}\n`); process.exit(1); });
