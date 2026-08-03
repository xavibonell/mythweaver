/**
 * THE PLAYER-SAFE PROJECTION (docs/PLAYER-INTERFACE.md, P1) — the only shape a player screen may receive.
 *
 * The live table has been rendering from the DM-grade payload: the campaign's intended ending, every NPC's
 * authored want/fear, unfired plants, hidden lurkers with coordinates, tool traces with DCs. The page drew
 * only the safe parts, but the secrets sat in the browser heap the whole time — client-side hiding is not
 * hiding.
 *
 * THE LAW (docs/PLAYER-INTERFACE.md §1): a datum reaches players only when play surfaced it. Filtering is
 * SERVER-SIDE and WHITELIST-shaped: we build the player object field by field rather than deleting from the
 * DM object, so a new DM-side field is invisible by default instead of leaking until someone remembers it.
 *
 * Pure functions, no I/O — same discipline as characterSheets/arcView, and unit-testable by the permanent
 * secret-scan in player-view.test.ts.
 */

import type { Chapter, CharacterSheet, Combatant, Dossier, GameState, ItemDef, JournalEvent, MapObject, SceneDelta, SceneMap } from '@mythweaver/shared';
import { deriveMoveCaps, spatialIndex, whereIs } from '@mythweaver/engine';

/** Engine-owned map state that must never reach a player (reaction/goal bookkeeping, sticky refusals). */
const SECRET_STATE_KEY = /^(rx:|cmd-refused:)/;

/**
 * ONE masking rule for unidentified items, shared by the sheet and by finding/loot prose — three call
 * sites once specified three different maskings, which is how one of them ends up leaking the true name.
 * `identified` is TRI-STATE in the catalog: only an explicit `false` means "known to be unknown".
 */
export function maskItem(def: Pick<ItemDef, 'name' | 'category' | 'magic'>, identified: boolean | undefined): { name: string; magic?: boolean } {
  if (identified === false) return { name: `an unidentified ${def.category ?? 'item'}` }; // never the name, never `magic`
  return { name: def.name, ...(def.magic ? { magic: true } : {}) };
}

/**
 * The arc, whitelisted to what the table has actually lived through. Everything the Director uses to STEER
 * is dramatic-irony fuel and stays server-side: intendedEnding, centralProblem, spine, the brief's reachable
 * hooks/bridgeNpcs/notes/clocks, unvisited beat titles, and per-beat encounters for fights not yet reached.
 * `activeBeatIntent` is explicitly NOT the party's goal — it is authored as "what this beat is really about",
 * i.e. a spoiler. Until the planner emits a player-safe `partyGoal` (P3), we show no goal rather than that one.
 */
export function playerArcView(state: GameState): { premise: string | null; goal: string | null; chapters: { id: string; title: string; current: boolean }[]; decisions: { key: string; value: string }[] } {
  const arc = state.arc ?? {};
  const adv = state.adventure;
  const brief = arc.brief as { partyGoal?: unknown } | undefined;
  const chapters = adv
    ? Object.entries(adv.scenes)
        // VISITED ONLY: a beat the party has closed, or the one they stand in. An unvisited title is a spoiler.
        .filter(([id]) => !!state.flags?.[`beat:${id}`] || id === state.currentSceneId)
        .map(([id, s]) => ({ id, title: s.title, current: id === state.currentSceneId }))
    : [];
  return {
    premise: arc.blueprint?.premise ?? null,
    // Only an explicitly player-safe goal field is ever shown (see above); absent ⇒ null, never a fallback.
    goal: typeof brief?.partyGoal === 'string' && brief.partyGoal ? brief.partyGoal : null,
    chapters,
    // decision:* flags are the PARTY's own recorded choices — safe by construction (npc:*/beat:* are not).
    decisions: Object.entries(state.flags ?? {}).filter(([k]) => k.startsWith('decision:')).map(([k, v]) => ({ key: k.slice(9), value: String(v) })),
  };
}

/** Is this actor concealed from the table by a building they are inside? Mirrors the DM-view rule that a
 *  name over a closed lid leaks that someone is in there — a player must not read an ambush out of the JSON. */
function hiddenIndoors(map: SceneMap, o: MapObject): boolean {
  if (o.kind !== 'actor' || o.role === 'pc') return false;
  try {
    const idx = spatialIndex(map);
    const b = whereIs(idx, { col: o.col, row: o.row }).buildingId;
    if (!b) return false;
    // Revealed = a PC is inside that same building (the party opened it / is standing in it).
    return !map.objects.some((p) => p.role === 'pc' && whereIs(idx, { col: p.col, row: p.row }).buildingId === b);
  } catch {
    return false; // oracle must never break a payload
  }
}

/** The map as the table can see it: no hidden tokens, no one concealed indoors, no engine bookkeeping,
 *  no exit destinations (a door labelled `loc:smugglers-cave` spoils what is behind it). */
export function playerSceneMap(map: SceneMap): SceneMap {
  const objects = map.objects
    .filter((o) => o.visible !== false && !hiddenIndoors(map, o))
    .map((o) => {
      if (!o.state) return o;
      const state = Object.fromEntries(Object.entries(o.state).filter(([k]) => !SECRET_STATE_KEY.test(k)));
      return Object.keys(state).length ? { ...o, state } : (({ state: _drop, ...rest }) => rest)(o) as MapObject;
    });
  const entrances = (map.entrances ?? []).map((e) => {
    const { toLocationId: _drop, ...rest } = e as { toLocationId?: string };
    return rest;
  });
  return { ...map, objects, entrances } as SceneMap;
}

/**
 * Deltas, resolved by VISIBILITY rather than by op shape. Filtering only `spawn visible:false` would still
 * stream a hidden stalker's every move/face/setState — updateScene and the reach gate both move ids without
 * a visibility check. So: resolve each op's id against the post-turn map and drop anything about a token the
 * player cannot see. `reveal` is the one transform: the player never had the object, so revealing it must
 * DELIVER it as a spawn. Any drop-induced drift self-heals — a rev gap makes the client re-fetch the map.
 */
export function projectDeltas(deltas: SceneDelta[], map: SceneMap | undefined): SceneDelta[] {
  if (!map) return [];
  const visible = new Set(map.objects.filter((o) => o.visible !== false && !hiddenIndoors(map, o)).map((o) => o.id));
  const out: SceneDelta[] = [];
  for (const d of deltas) {
    const id = 'id' in d ? (d.id as string) : undefined;
    if (d.op === 'reveal') {
      const obj = map.objects.find((o) => o.id === id);
      if (obj && visible.has(obj.id)) out.push({ op: 'spawn', object: obj, at: { col: obj.col, row: obj.row } } as unknown as SceneDelta);
      continue;
    }
    if (d.op === 'spawn') {
      const o = (d as unknown as { object?: MapObject }).object;
      if (o && o.visible === false) continue;
      out.push(d);
      continue;
    }
    if (id && !visible.has(id)) continue; // move/face/setState/hide/despawn of something unseen
    if (d.op === 'setState') {
      const s = (d as unknown as { state?: Record<string, unknown> }).state ?? {};
      const kept = Object.fromEntries(Object.entries(s).filter(([k]) => !SECRET_STATE_KEY.test(k)));
      if (!Object.keys(kept).length) continue; // the whole op was engine bookkeeping
      out.push({ ...d, state: kept } as SceneDelta);
      continue;
    }
    out.push(d);
  }
  return out;
}

/** The turn as the table experienced it: the DM's words and the world's response. No tool traces (they
 *  carry DCs and POI contents), no state diff, no scene provenance, no exemplars, no cost/model/steps. */
export function playerTurn(turn: Record<string, unknown>, map: SceneMap | undefined): Record<string, unknown> {
  return {
    index: turn.index,
    speaker: turn.speaker,
    input: turn.input,
    kind: turn.kind,
    narration: turn.narration,
    ...(turn.beat ? { beat: turn.beat } : {}),
    mentions: turn.mentions ?? [],
    deltas: projectDeltas((turn.deltas as SceneDelta[]) ?? [], map),
  };
}

/** Party sheets with the one leak the DM serializer carries: an unidentified item's true name + magic flag. */
/**
 * COMBAT VIEW (docs/COMBAT-MODE.md C2) — the fight as the table may see it.
 *
 * Enemy health ships as a WORD, never a number: exact monster HP is authored truth the players have
 * not earned (the same law as every other lane here), and "how hurt is it?" is better D&D as table
 * texture anyway. The party's own numbers live on the dock; the rail speaks in states for everyone.
 * The ACTIVE PC also gets their action-economy pips and the cells their remaining movement can reach
 * (a plain walkable BFS — difficult terrain refinement can come with the oracle later).
 */
export interface PlayerCombatView {
  round: number;
  activeId: string | null;
  /** Grouped ally turns (C3): every un-ended member of the current PC block may act — the rail glows
   *  all of them, and any of their seats may End Turn for themselves. */
  activeIds: string[];
  order: { id: string; name: string; kind: 'pc' | 'npc'; healthWord: string; down: boolean; isActive: boolean }[];
  /** Present only while a PC is active — the SPOTLIGHT's turn budget (their knowledge by definition). */
  active?: { id: string; name: string; action: boolean; bonusAction: boolean; movementRemainingFt: number };
  /** Per-member budgets for the whole un-ended block — the pips follow whichever ally is speaking. */
  block?: { id: string; name: string; action: boolean; bonusAction: boolean; movementRemainingFt: number }[];
  /** Cells the active PC can still reach this turn (movement tint). Empty when not a PC's turn. */
  moveRange?: { col: number; row: number }[];
}

/** Pure mirror of the ENGINE's block rule (Engine.currentBlock/activeIds) — combat-turns tests pin
 *  the two to each other. Duplicated because the projection works on bare state, not an Engine. */
function blockActiveIds(state: GameState): string[] {
  const cs = state.combat;
  if (!cs?.active || !cs.order.length) return [];
  const at = cs.turnIndex;
  const dying = (c?: Combatant) => !!c && c.kind === 'pc' && !!c.downed && !c.dead && (c.deathSaves?.successes ?? 0) < 3;
  const actable = (c?: Combatant) => !!c && !c.dead && !c.fled && (!c.downed || dying(c));
  const spot = state.combatants[cs.order[at]!];
  if (!spot) return [];
  if (spot.kind !== 'pc' || dying(spot)) return [cs.order[at]!];
  const isBlockPc = (i: number) => { const c = state.combatants[cs.order[i]!]; return !!c && c.kind === 'pc' && !dying(c); };
  let lo = at, hi = at;
  while (lo - 1 >= 0 && isBlockPc(lo - 1)) lo--;
  while (hi + 1 < cs.order.length && isBlockPc(hi + 1)) hi++;
  const ended = new Set(cs.blockEnded ?? []);
  return cs.order.slice(lo, hi + 1).filter((id) => !ended.has(id) && actable(state.combatants[id]));
}

const healthWord = (c: Combatant): string => {
  if (c.dead) return 'dead';
  if (c.downed) return 'down';
  const r = c.maxHitPoints > 0 ? c.currentHitPoints / c.maxHitPoints : 1;
  if (r >= 1) return 'unharmed';
  if (r >= 0.5) return 'wounded';
  if (r >= 0.25) return 'bloodied';
  return 'near death';
};

/** 8-direction BFS over walkable ground within the movement budget (Chebyshev grid — a diagonal step
 *  is one cell, matching the engine's distance rule). Occupied cells stay tintable: squeezing past is
 *  the walk gate's ruling at travel time, not the preview's. */
function reachableCells(map: SceneMap, from: { col: number; row: number }, budgetFt: number): { col: number; row: number }[] {
  const feet = map.grid?.feetPerTile ?? 5;
  const steps = Math.floor(budgetFt / feet);
  if (steps <= 0) return [];
  const { cols, rows } = map.grid;
  const seen = new Set<number>([from.row * cols + from.col]);
  let frontier = [from];
  const out: { col: number; row: number }[] = [];
  for (let d = 0; d < steps && frontier.length; d++) {
    const next: { col: number; row: number }[] = [];
    for (const cell of frontier) {
      for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
        if (!dc && !dr) continue;
        const col = cell.col + dc, row = cell.row + dr;
        if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
        const k = row * cols + col;
        if (seen.has(k) || !map.walkable?.[row]?.[col]) continue;
        seen.add(k);
        next.push({ col, row });
        out.push({ col, row });
      }
    }
    frontier = next;
  }
  return out;
}

export function playerCombatView(state: GameState): PlayerCombatView | null {
  const cs = state.combat;
  if (!cs?.active || !cs.order.length) return null;
  const activeId = cs.order[cs.turnIndex] ?? null;
  const order = cs.order
    .map((id) => state.combatants[id])
    .filter((c): c is Combatant => !!c)
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      healthWord: healthWord(c),
      down: !!(c.downed || c.dead),
      isActive: c.id === activeId,
    }));
  const ids = blockActiveIds(state);
  const view: PlayerCombatView = { round: cs.round, activeId, activeIds: ids, order };
  const budgets = ids
    .map((id) => state.combatants[id])
    .filter((c): c is Combatant => !!c && c.kind === 'pc')
    .map((c) => {
      const ae = c.actionEconomy ?? { action: true, bonusAction: true, reaction: true, movementRemainingFt: deriveMoveCaps(state, c.id).speedFt };
      return { id: c.id, name: c.name, action: ae.action, bonusAction: ae.bonusAction, movementRemainingFt: ae.movementRemainingFt };
    });
  if (budgets.length) view.block = budgets;
  const active = activeId ? state.combatants[activeId] : undefined;
  if (active?.kind === 'pc') {
    // A save frozen before the economy existed has no budget fields yet — an untouched turn IS the
    // full budget, so derive exactly what refreshEconomy would seed rather than hiding the pips.
    const ae = active.actionEconomy ?? { action: true, bonusAction: true, reaction: true, movementRemainingFt: deriveMoveCaps(state, active.id).speedFt };
    view.active = {
      id: active.id, name: active.name,
      action: ae.action,
      bonusAction: ae.bonusAction,
      movementRemainingFt: ae.movementRemainingFt,
    };
    const map = state.world?.currentLocationId ? state.world.locations[state.world.currentLocationId] : undefined;
    const tok = map?.objects.find((o) => o.id === active.id);
    if (map && tok) view.moveRange = reachableCells(map, { col: tok.col, row: tok.row }, ae.movementRemainingFt);
  }
  return view;
}

export function playerCharacters(characters: Record<string, unknown>[]): Record<string, unknown>[] {
  return characters.map((c) => {
    const items = (c.items as { name?: string; category?: string; magic?: boolean; identified?: boolean }[] | undefined) ?? undefined;
    if (!items) return c;
    return {
      ...c,
      items: items.map((it) => {
        const masked = maskItem({ name: it.name ?? 'item', category: it.category ?? 'item', magic: it.magic }, it.identified);
        // Drop `charges` alongside the name — a charge count is itself a tell that the thing is magical.
        const { magic: _m, charges: _c, ...rest } = it as Record<string, unknown>;
        return { ...rest, ...masked };
      }),
    };
  });
}

/** Party sheets ALSO need the table to see a dying PC — additive, never reshaping the pinned contract. */
export type PlayerSheet = CharacterSheet & { downed?: boolean; deathSaves?: { successes: number; failures: number } };

/**
 * THE BOOK — a pure fold over the journal (docs/PLAYER-INTERFACE.md §2). No filtering happens here:
 * every event was already composed player-safe at write time, which is exactly what lets this ship
 * verbatim. This function only ORGANISES: events into chapters, and the people/things they name into
 * dossiers that grow.
 */
export function playerBook(state: GameState): { prologue: string | null; chapters: Chapter[]; people: Dossier[]; findings: JournalEvent[] } {
  const all = state.journal ?? [];
  // The prologue is the Book's opening PAGE and a chronicle is a chapter's PROSE — neither is a row.
  const prologue = all.find((e) => e.kind === 'prologue')?.text ?? null;
  const chronicles = new Map(all.filter((e) => e.kind === 'chronicle').map((e) => [e.beatId, e.text]));
  const events = all.filter((e) => e.kind !== 'prologue' && e.kind !== 'chronicle');
  const titles = state.adventure?.scenes ?? {};

  // CHAPTERS, in the order the party lived them. A beat only appears once it has events, so an
  // unvisited beat cannot leak here even if the adventure defines it.
  const order: string[] = [];
  const byBeat = new Map<string, JournalEvent[]>();
  for (const ev of events) {
    if (!byBeat.has(ev.beatId)) { byBeat.set(ev.beatId, []); order.push(ev.beatId); }
    byBeat.get(ev.beatId)!.push(ev);
  }
  if (!order.includes(state.currentSceneId)) order.push(state.currentSceneId); // the beat we're in, even if quiet
  // A `met` event is a PERSON's arrival record — it births their entry and carries the sentence that
  // introduced them. Rendering it as a Journal row too says the same moment twice, because the beat
  // line for that turn already narrates the encounter. So: folded for People, not listed for Journal.
  const isRow = (e: JournalEvent) => e.kind !== 'met' && e.kind !== 'insight';
  const chapters: Chapter[] = order.map((beatId) => {
    const evs = (byBeat.get(beatId) ?? []).filter(isRow);
    // The goal as it stood DURING this chapter — the live brief is overwritten on every replan, so the
    // snapshot is the only way a closed chapter remembers what the party was trying to do.
    const goal = [...evs].reverse().find((e) => e.kind === 'goal')?.text;
    // The closing marker is journaled AFTER currentSceneId flips, so it lives in the NEXT beat's
    // group — search the whole stream for it, not this chapter's own rows.
    const closed = events.find((e) => e.kind === 'chapter' && e.data?.from === beatId);
    const summary = chronicles.get(beatId);
    return {
      beatId,
      title: (titles[beatId]?.title as string | undefined) ?? beatId,
      ...(goal ? { goal } : {}),
      ...(closed?.data?.outcome ? { outcome: String(closed.data.outcome) } : {}),
      ...(summary ? { summary } : {}),
      current: beatId === state.currentSceneId,
      events: evs,
    };
  });

  // DOSSIERS. An entry is BORN from the first event that names a card — never from the ledger, which
  // holds cast the composer authored long before the party could meet them (a P0 probe also killed the
  // idea of birthing from narration `mentions`: in a real run those came back PC-only).
  const cards = state.ledger?.entities ?? {};
  const people = new Map<string, Dossier>();
  for (const ev of events) {
    for (const id of ev.subjects) {
      const card = cards[id];
      if (!card) continue; // POIs and map ids are findings, not people
      let d = people.get(id);
      if (!d) {
        d = { id, name: card.name, firstSeen: { turn: ev.turn, beatId: ev.beatId }, lastSeen: { turn: ev.turn, beatId: ev.beatId }, regard: 0, deeds: [] };
        people.set(id, d);
      }
      d.lastSeen = { turn: ev.turn, beatId: ev.beatId };
      if (ev.kind === 'disposition') d.regard += Number(ev.data?.dir ?? 0); // witnessed shifts only, from 0
      if (ev.kind === 'met' && !d.appearance && ev.data?.appearance) d.appearance = String(ev.data.appearance);
      // The party's READ, latest wins — a sheet of what we know, not a replay of what happened
      // (the Journal owns that; repeating it in the entry was the redundancy the table called out).
      if (ev.kind === 'insight' && ev.data) {
        const p = (k: string) => (ev.data![k] !== undefined ? String(ev.data![k]) : undefined);
        const list = (k: string) => (p(k) ? p(k)!.split(' · ').filter(Boolean) : undefined);
        if (p('manner')) d.manner = p('manner');
        if (list('traits')) d.traits = list('traits');
        if (list('carries')) d.carries = list('carries');
        if (p('candor')) d.candor = p('candor');
        if (!d.appearance && p('appearance')) d.appearance = p('appearance');
      }
      if (ev.kind === 'verdict' || ev.kind === 'clue' || ev.kind === 'beat') d.deeds.unshift({ seq: ev.seq, turn: ev.turn, text: ev.text });
    }
  }
  for (const d of people.values()) d.deeds = d.deeds.slice(0, 12); // newest few; the chapter holds the rest

  return {
    prologue,
    chapters,
    people: [...people.values()],
    // Clues sit with findings: both are "what the party now knows", whatever tab a reader checks first.
    findings: events.filter((e) => e.kind === 'finding' || e.kind === 'loot' || e.kind === 'clue'),
  };
}
