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

import type { CharacterSheet, GameState, ItemDef, MapObject, SceneDelta, SceneMap } from '@mythweaver/shared';
import { spatialIndex, whereIs } from '@mythweaver/engine';

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
