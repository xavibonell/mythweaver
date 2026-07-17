/**
 * SCENE GRAPH (coherence P1) — the DM reads PLACES, not object soup.
 *
 * The unbounded-hallucination class (docs/DM-GROUNDING.md): a terse "NPC (id): 40 ft NE of the party"
 * digest lets the DM invent membership ("Hobb at the anvil" when Hobb stands outdoors) and earshot
 * ("Tessa calls from behind you" at 110 ft). This module projects the SceneMap + spatial oracle into a
 * ZONE model — who is in which room / on the open ground — plus an egocentric earshot band around the
 * ACTING PC. That is the ground truth two whole leak classes were violating: MEMBERSHIP and PROXIMITY.
 *
 * Pure + oracle-derived (no schema changes, no persistence). `narrationBreaksScene` is the deterministic
 * gate twin of the swim fidelity gate: it flags prose that contradicts membership/earshot so the turn loop
 * can bind the narration to the map (bounded re-narrate), never inform-and-hope.
 */
import type { EntityId, SceneMap } from '@mythweaver/shared';
import { whereIs, distanceFt, hasLineOfSight, type SpatialIndex } from '@mythweaver/engine';

// ---------------------------------------------------------------------------------------------------
// Building naming (owned here — the low-level module; the orchestrator imports these back).
// ---------------------------------------------------------------------------------------------------

/** A building is NAMED BY ITS INTERIOR (a forge inside ⇒ "the forge"). The furniture is ground truth
 *  of what a building IS — the scene's SceneSpec is often dropped, so names can't come from the arc. */
export function classifyBuilding(tags: Set<string>): string {
  const has = (...t: string[]) => t.some((x) => tags.has(x));
  if (has('forge', 'anvil', 'bellows')) return 'forge';
  if (has('bar_counter', 'ale_barrel', 'beer_keg', 'tankard')) return 'inn';
  if (has('altar', 'shrine', 'pew', 'reliquary')) return 'chapel';
  if (has('shelf_wares', 'sacks', 'grain', 'grain_sack', 'crate_stack', 'market_stall')) return 'storehouse';
  if (has('bed', 'bed_down') && tags.size <= 4) return 'cottage';
  return 'house';
}

export interface DerivedBuilding { id: string; name: string; type: string; col: number; row: number; }

/** Reify buildings from the oracle's roof footprints; each exposes its real DOOR cell (map.entrances,
 *  matched by fixtureId; legacy nearest-walkable-ring guess only when a map carries no entrance). */
export function deriveBuildings(map: SceneMap, idx: SpatialIndex, near?: { col: number; row: number }): DerivedBuilding[] {
  if (!idx.roofAt?.size) return [];
  const cols = map.grid.cols, rows = map.grid.rows;
  const box = new Map<string, { minc: number; maxc: number; minr: number; maxr: number }>();
  for (const [k, bid] of idx.roofAt) {
    const c = k % cols, r = (k - c) / cols;
    const g = box.get(bid) ?? { minc: 1e9, maxc: -1, minr: 1e9, maxr: -1 };
    g.minc = Math.min(g.minc, c); g.maxc = Math.max(g.maxc, c); g.minr = Math.min(g.minr, r); g.maxr = Math.max(g.maxr, r);
    box.set(bid, g);
  }
  const doorByBid = new Map<string, { col: number; row: number }>();
  for (const e of map.entrances ?? []) {
    if (e.fixtureId && Number.isInteger(e.col) && Number.isInteger(e.row)) doorByBid.set(e.fixtureId, { col: e.col, row: e.row });
  }
  const aim = near ?? { col: Math.round(cols / 2), row: Math.round(rows / 2) };
  const out: DerivedBuilding[] = [];
  for (const [bid, bb] of box) {
    const inB = (o: { col: number; row: number }) => o.col >= bb.minc && o.col <= bb.maxc && o.row >= bb.minr && o.row <= bb.maxr;
    const tags = new Set(map.objects.filter((o) => o.kind !== 'actor' && o.visible !== false && inB(o)).map((o) => o.tag));
    const type = classifyBuilding(tags);
    let door: { col: number; row: number } | null = doorByBid.get(bid) ?? null;
    if (!door) {
      let bestD = Infinity;
      for (let r = bb.minr - 1; r <= bb.maxr + 1; r++) for (let c = bb.minc - 1; c <= bb.maxc + 1; c++) {
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        if (!(c === bb.minc - 1 || c === bb.maxc + 1 || r === bb.minr - 1 || r === bb.maxr + 1)) continue;
        if (map.walkable?.[r]?.[c] !== true || idx.roofAt.has(r * cols + c)) continue;
        const d = Math.abs(c - aim.col) + Math.abs(r - aim.row);
        if (d < bestD) { bestD = d; door = { col: c, row: r }; }
      }
    }
    if (door) out.push({ id: bid, name: `the ${type}`, type, col: door.col, row: door.row });
  }
  return out;
}

/** A synthetic MapObject for a derived building (its door cell), so travel/digest treat it as a target. */
export function buildingAsObject(b: DerivedBuilding): SceneMap['objects'][number] {
  return { id: b.id, kind: 'fixture', tag: b.type, name: b.name, col: b.col, row: b.row, footprint: { w: 1, h: 1 }, facing: 'down', visible: false } as SceneMap['objects'][number];
}

// ---------------------------------------------------------------------------------------------------
// The zone graph.
// ---------------------------------------------------------------------------------------------------

export const REACH_FT = 15; // arm's reach / a normal conversation
export const EARSHOT_FT = 60; // a raised voice carries about this far in a busy village; beyond = out of scene

/** The signature INTERIOR station of a building type — where the DM tends to (wrongly) place people. */
const STATION_NOUN: Record<string, string> = {
  forge: 'the anvil', inn: 'the bar', chapel: 'the altar', storehouse: 'the shelves',
  cottage: 'the hearth', house: 'the hearth', shop: 'the counter',
};
/** Words that, in prose, assert someone is AT a building's interior station (per building type). */
const STATION_WORDS: Record<string, RegExp> = {
  forge: /\b(anvil|bellows|forge[- ]?fire|smith(?:y)?[- ]?fire)\b/i,
  inn: /\b(bar|counter|tap|taproom|ale[- ]?barrel)\b/i,
  chapel: /\b(altar|pew|reliquary|shrine)\b/i,
  storehouse: /\b(shelves|shelf|stacks|grain[- ]?sacks?)\b/i,
  cottage: /\b(hearth|fireplace)\b/i,
  house: /\b(hearth|fireplace)\b/i,
  shop: /\b(counter|stall)\b/i,
};

export interface Zone {
  id: string;
  kind: 'interior' | 'outdoor';
  name: string; // "the forge", "the open ground"
  buildingId?: EntityId;
  type?: string; // building type for interiors
  occupants: { id: EntityId; name?: string; role?: string; tag?: string }[];
  contents: string[]; // interior furniture nouns
  sizeFt?: string; // "25×20 ft"
}

/** Human label for an actor: proper name, else a role-noun ("the keeper" indoors, else "a villager") —
 *  never the raw id (which reads like garbage to the DM and invites it to invent a name). */
function displayActor(o: { id: EntityId; name?: string; tag?: string }): string {
  if (o.name) return o.name;
  if (o.id.endsWith('keeper')) return 'the keeper (unnamed)';
  const t = humanTag(o.tag ?? '');
  return t ? `a ${t}` : 'someone';
}
export interface SceneGraph {
  zones: Zone[];
  zoneOf: Map<EntityId, string>; // actor id → zone id
  buildings: DerivedBuilding[];
}

function humanTag(tag: string): string {
  return tag.replace(/[_-]+/g, ' ').replace(/\d+/g, '').trim() || 'object';
}
function bboxOf(idx: SpatialIndex, buildingId: string): { minc: number; maxc: number; minr: number; maxr: number } | null {
  let g: { minc: number; maxc: number; minr: number; maxr: number } | null = null;
  for (const [k, bid] of idx.roofAt) {
    if (bid !== buildingId) continue;
    const c = k % idx.cols, r = (k - c) / idx.cols;
    g ??= { minc: 1e9, maxc: -1, minr: 1e9, maxr: -1 };
    g.minc = Math.min(g.minc, c); g.maxc = Math.max(g.maxc, c); g.minr = Math.min(g.minr, r); g.maxr = Math.max(g.maxr, r);
  }
  return g;
}
function compass8(dcol: number, drow: number): string {
  if (dcol === 0 && drow === 0) return 'here';
  const ns = drow < 0 ? 'N' : drow > 0 ? 'S' : '';
  const ew = dcol < 0 ? 'W' : dcol > 0 ? 'E' : '';
  return (ns + ew) || 'here';
}

/** Project the map into zones with per-actor membership. Every VISIBLE actor lands in exactly one zone:
 *  the interior of the building whose roof it stands under, else the single "open ground" zone. */
export function sceneGraph(map: SceneMap, idx: SpatialIndex): SceneGraph {
  const buildings = deriveBuildings(map, idx);
  const zones: Zone[] = [];
  const byBid = new Map<string, Zone>();
  for (const b of buildings) {
    const bb = bboxOf(idx, b.id);
    const contents = [
      ...new Set(
        map.objects
          .filter((o) => o.kind !== 'actor' && o.visible !== false && idx.roofAt.get(o.row * idx.cols + o.col) === b.id)
          .map((o) => humanTag(o.tag)), // the furniture noun — NOT o.group (which is the building id)
      ),
    ].filter((t) => t && !t.startsWith('bldg')).slice(0, 4);
    const z: Zone = {
      id: b.id, kind: 'interior', name: b.name, buildingId: b.id, type: b.type, occupants: [], contents,
      ...(bb ? { sizeFt: `${(bb.maxc - bb.minc + 1) * idx.feetPerTile}×${(bb.maxr - bb.minr + 1) * idx.feetPerTile} ft` } : {}),
    };
    zones.push(z);
    byBid.set(b.id, z);
  }
  const outdoor: Zone = { id: 'outdoor', kind: 'outdoor', name: 'the open ground', occupants: [], contents: [] };
  zones.push(outdoor);

  const zoneOf = new Map<EntityId, string>();
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.visible === false) continue;
    const w = whereIs(idx, o);
    const z = (w.indoor && w.buildingId && byBid.get(w.buildingId)) || outdoor;
    z.occupants.push({ id: o.id, name: o.name, role: o.role, tag: o.tag });
    zoneOf.set(o.id, z.id);
  }
  return { zones, zoneOf, buildings };
}

/** The nearest building door within `maxTiles` of an outdoor actor — "by the forge door (outside)". */
function nearestDoor(g: SceneGraph, col: number, row: number, maxTiles = 3): DerivedBuilding | undefined {
  let best: DerivedBuilding | undefined, bd = Infinity;
  for (const b of g.buildings) {
    const d = Math.max(Math.abs(b.col - col), Math.abs(b.row - row));
    if (d <= maxTiles && d < bd) { bd = d; best = b; }
  }
  return best;
}

/** The authoritative WHO-IS-WHERE block. Membership per zone + an egocentric earshot band for the acting
 *  PC. Marked as superseding earlier narration — the anti-stale-tableau strike, every turn. */
export function zoneDigest(map: SceneMap, idx: SpatialIndex, actingPcName?: string): string {
  const g = sceneGraph(map, idx);
  const objById = new Map(map.objects.map((o) => [o.id, o] as const));
  const label = displayActor;

  const interiorLines = g.zones
    .filter((z) => z.kind === 'interior' && z.type !== 'house') // anonymous houses are noise
    .map((z) => {
      const who = z.occupants.length ? z.occupants.map(label).join(', ') : 'EMPTY (no one inside)';
      // PERCEPTION BOUNDARY: an interior with no PC in it is behind walls + a closed door — the party CANNOT
      // see in. The DM keeps enough to KNOW someone's there (planning), but the furniture (pure visual
      // detail) is DROPPED for unentered buildings — it only tempts narration — and the whole line is
      // flagged UNSEEN so GM-knowledge never becomes narrated perception (the "closed-door" leak).
      const partyInside = z.occupants.some((o) => o.role === 'pc');
      const inside = partyInside && z.contents.length ? ` [inside: ${z.contents.join(', ')}]` : '';
      const unseen = partyInside ? '' : ' — UNSEEN by the party (GM-only: you know someone is here; the characters cannot perceive inside until they ENTER — do NOT narrate this interior or its occupants as observed)';
      return `  · ${z.name}${z.sizeFt ? ` (interior, ${z.sizeFt})` : ''} — ${who}${inside}${unseen}`;
    });

  const outdoor = g.zones.find((z) => z.kind === 'outdoor');
  const outLine = outdoor
    ? `  · OPEN GROUND (outdoors) — ${outdoor.occupants.length
        ? outdoor.occupants.map((occ) => {
            const o = objById.get(occ.id);
            const door = o ? nearestDoor(g, o.col, o.row) : undefined;
            return `${label(occ)}${door ? ` [by ${door.name} door — OUTSIDE it, not within]` : ''}`;
          }).join(', ')
        : 'no one'}`
    : '';

  const nearby = actingPcName ? nearbyLine(map, idx, actingPcName) : '';
  return [
    `=== SCENE — WHO IS WHERE (authoritative; SUPERSEDES all earlier narration incl. the opening — people have MOVED since then) ===`,
    ...interiorLines,
    outLine,
    ...(nearby ? [nearby] : []),
    `(Narrate people WHERE THEY STAND. Someone "at the anvil"/"inside" must be listed in that interior; a person outdoors is NOT at an interior station. To put them there, move them first.)`,
  ].filter(Boolean).join('\n');
}

/** Egocentric earshot around the ACTING PC — reach / shout / out-of-scene bands. This is the line that
 *  kills "an NPC 110 ft away speaks to you": beyond ~60 ft they cannot address the acting PC this turn. */
export function nearbyLine(map: SceneMap, idx: SpatialIndex, actingPcName: string): string {
  const pc = (map.objects ?? []).find((o) => o.role === 'pc' && (o.name ?? '').toLowerCase() === actingPcName.trim().toLowerCase());
  if (!pc) return '';
  const reach: string[] = [], shout: string[] = [], farNamed: string[] = [];
  let farAnon = 0;
  for (const o of map.objects) {
    if (o.kind !== 'actor' || o.visible === false || o.id === pc.id) continue;
    const d = distanceFt(idx, pc, o);
    const los = hasLineOfSight(idx, pc, o).clear;
    const who = `${displayActor(o)} (${d} ft${los ? '' : ', not in sight'})`;
    if (d <= REACH_FT) reach.push(who);
    else if (d <= EARSHOT_FT) shout.push(who);
    else if (o.name) farNamed.push(o.name);
    else farAnon++;
  }
  const far = [...farNamed, ...(farAnon ? [`${farAnon} unnamed villagers/keepers`] : [])];
  // WHICH DOOR is the acting PC standing at? "enter the house I'm in front of" is unresolvable unless the
  // DM knows the PC's ADJACENT building. Report the nearest building door within 2 tiles — it disambiguates.
  let atDoor: { b: DerivedBuilding; d: number } | undefined;
  for (const b of deriveBuildings(map, idx)) {
    const d = Math.max(Math.abs(b.col - pc.col), Math.abs(b.row - pc.row));
    if (d <= 2 && (!atDoor || d < atDoor.d)) atDoor = { b, d };
  }
  const doorLine = atDoor
    ? ` ${pc.name} is standing AT the door of ${atDoor.b.name} (${atDoor.d * idx.feetPerTile} ft) — "enter"/"go inside"/"the house I'm in front of" means THIS building (${atDoor.b.id}), not another.`
    : '';
  return (
    `  AROUND ${pc.name} (the acting character): ` +
    `within reach ≤${REACH_FT} ft: ${reach.join(', ') || 'no one'}; ` +
    `in earshot ≤${EARSHOT_FT} ft (a raised voice): ${shout.join(', ') || 'no one'}; ` +
    `OUT OF SCENE >${EARSHOT_FT} ft (cannot hear, speak to, or react to ${pc.name} this turn — they must move closer first): ${far.join(', ') || 'no one'}.` +
    doorLine
  );
}

/** A compact "you are now here" note for a travel tool RESULT, so mid-turn the DM narrates from the
 *  POST-move zone + earshot, not the stale opening positions (the mid-turn staleness fix). */
export function arrivalZoneNote(map: SceneMap, idx: SpatialIndex, actor: { id: EntityId; name?: string }, at: { col: number; row: number }): string {
  const w = whereIs(idx, at);
  const g = sceneGraph(map, idx);
  const zone = w.indoor ? (g.buildings.find((b) => b.id === w.buildingId)?.name ?? 'inside a building') : 'on the open ground (outdoors)';
  const near = map.objects
    .filter((o) => o.kind === 'actor' && o.visible !== false && o.id !== actor.id)
    .map((o) => ({ o, d: distanceFt(idx, at, o) }))
    .filter((x) => x.d <= EARSHOT_FT)
    .sort((a, b) => a.d - b.d)
    // heard-not-seen: a contact behind a wall (LOS blocked, e.g. inside a building the mover isn't in) is
    // audible but NOT visible — mark it so the DM doesn't narrate an unseen indoor NPC as plainly present.
    .map((x) => `${x.o.name ?? x.o.id} (${x.d} ft${hasLineOfSight(idx, at, x.o).clear ? '' : ', heard not seen'})`);
  return `NOW ${actor.name ?? actor.id} is ${zone}. Within earshot ≤${EARSHOT_FT} ft: ${near.join(', ') || 'no one — no one is close enough to speak with them here'}. Narrate from THIS (positions changed this turn), not the earlier scene.`;
}

// ---------------------------------------------------------------------------------------------------
// The deterministic coherence gate (P2).
// ---------------------------------------------------------------------------------------------------

export interface CoherenceBreak { code: 'membership' | 'earshot'; reason: string; corrective: string; }

const SPEECH_VERB = /\b(say|says|said|call|calls|called|calls out|shout|shouts|shouted|mutter|mutters|muttered|reply|replies|replied|answer|answers|answered|snap|snaps|snapped|add|adds|added)\b/i;
const PROXIMITY_PHRASE = /\b(behind you|beside you|at your shoulder|next to you|by your side|over your shoulder|at your elbow)\b/i;

/** Does the narration contradict the zone/earshot ground truth? Conjunction-heavy by design (name AND a
 *  place/speech cue AND a contradicting oracle fact) so it fires on the real leaks, not on good prose.
 *  Returns the first break found (with a templated corrective), or null. */
export function narrationBreaksScene(map: SceneMap, idx: SpatialIndex, narration: string, actingPcName?: string, movedFrom?: Map<string, { col: number; row: number }>): CoherenceBreak | null {
  if (!narration) return null;
  const g = sceneGraph(map, idx);
  const objById = new Map(map.objects.map((o) => [o.id, o] as const));
  const text = narration;
  const lc = text.toLowerCase();

  // Named NPCs that appear in the prose — by FULL name OR first name (DMs write "Tessa", not "Tessa Reed").
  const npcs = map.objects.filter((o) => o.kind === 'actor' && o.role === 'npc' && o.visible !== false && o.name);
  const mentioned: { npc: (typeof npcs)[number]; nameIdx: number }[] = [];
  for (const npc of npcs) {
    const full = npc.name!.toLowerCase();
    const first = full.split(/\s+/)[0] ?? full;
    let at = lc.indexOf(full);
    if (at < 0 && first.length >= 4) at = lc.indexOf(first);
    if (at >= 0) mentioned.push({ npc, nameIdx: at });
  }

  // CHECK 1 — MEMBERSHIP: an NPC narrated AT an interior station of a building they are not inside.
  for (const { npc, nameIdx } of mentioned) {
    const zoneId = g.zoneOf.get(npc.id);
    // If the NPC MOVED this turn (a reaction/DM move), its turn-START zone is also a legitimate referent —
    // "she was at the anvil" right before fleeing out isn't a contradiction. Pass on either endpoint.
    const startCell = movedFrom?.get(npc.id);
    const startZoneId = startCell ? (whereIs(idx, startCell).buildingId ?? 'outdoor') : undefined;
    const window = lc.slice(Math.max(0, nameIdx - 40), nameIdx + (npc.name!.length) + 70); // the clause around the name
    for (const b of g.buildings) {
      if (zoneId === b.id || startZoneId === b.id) continue; // they ARE (or just were) inside this building — fine
      const stationRe = STATION_WORDS[b.type];
      // "inside the chapel" — the containment word must sit DIRECTLY on the building noun. A gap regex
      // ("in …≤20 chars… chapel") false-fired on "in the dusk NEAR the chapel" and burned a re-narrate
      // against true facts (the red-team's conjunction-discipline warning, observed live).
      const insideRe = new RegExp(`\\b(inside|within|into|in)\\s+(the\\s+)?${b.type}\\b`, 'i');
      const atStation = (stationRe && stationRe.test(window)) || insideRe.test(window);
      if (!atStation) continue;
      // Only flag when THIS building is the plausible referent: it must be the nearest building of its
      // type to the NPC (avoids flagging a mention of "the anvil" in a two-forge town for the far one).
      const nearestOfType = g.buildings
        .filter((x) => x.type === b.type)
        .sort((x, y) => Math.max(Math.abs(x.col - npc.col), Math.abs(x.row - npc.row)) - Math.max(Math.abs(y.col - npc.col), Math.abs(y.row - npc.row)))[0];
      if (nearestOfType && nearestOfType.id !== b.id) continue;
      const door = nearestDoor(g, npc.col, npc.row) ?? b;
      const dFt = distanceFt(idx, npc, { col: b.col, row: b.row });
      const where = zoneId === 'outdoor' ? `outdoors on the open ground, ~${dFt} ft from ${b.name} door` : `not inside ${b.name}`;
      return {
        code: 'membership',
        reason: `${npc.name} narrated at ${STATION_NOUN[b.type] ?? 'an interior station'} / inside ${b.name}, but is ${where}`,
        corrective: `[COHERENCE: ${npc.name} is ${where} — NOT inside ${b.name} and NOT at ${STATION_NOUN[b.type] ?? 'its interior'}. Rewrite so ${npc.name} is where they actually stand (${where}); to put them at ${STATION_NOUN[b.type] ?? 'the interior'}, they must walk there first. Rewrite the WHOLE reply as scene narration in your normal voice — do NOT quote, restate, or paraphrase this note; call no tools.]`,
      };
    }
  }

  // CHECK 2 — EARSHOT: an NPC given a spoken line / put "behind you" while too far from the acting PC.
  if (actingPcName) {
    const pc = (map.objects ?? []).find((o) => o.role === 'pc' && (o.name ?? '').toLowerCase() === actingPcName.trim().toLowerCase());
    if (pc) {
      for (const { npc, nameIdx } of mentioned) {
        const dFt = distanceFt(idx, pc, npc);
        // A parting line from an NPC who FLED this turn ("Tessa cries out as she runs") is legit: she was in
        // earshot when she cried. Gate on the CLOSEST of {turn-start, now} so we never re-narrate true prose.
        const startCell = movedFrom?.get(npc.id);
        const dEff = startCell ? Math.min(dFt, distanceFt(idx, pc, { col: startCell.col, row: startCell.row })) : dFt;
        const after = text.slice(nameIdx, nameIdx + npc.name!.length + 45); // the clause right after the name
        const before = text.slice(Math.max(0, nameIdx - 45), nameIdx);
        const speaks = SPEECH_VERB.test(after) || /["“][^"”]{0,60}["”]\s*$/.test(before);
        const proximate = PROXIMITY_PHRASE.test(before) || PROXIMITY_PHRASE.test(after);
        if (speaks && dEff > EARSHOT_FT) {
          return {
            code: 'earshot',
            reason: `${npc.name} speaks to/near ${pc.name} but is ${dFt} ft away (> ${EARSHOT_FT} ft earshot)`,
            corrective: `[COHERENCE: ${npc.name} is ${dFt} ft from ${pc.name} — out of speaking range (a raised voice carries ~${EARSHOT_FT} ft in a busy village). Rewrite without ${npc.name} addressing ${pc.name} from there: show them only as a distant figure, or move them closer first. Rewrite the WHOLE reply as scene narration in your normal voice — do NOT quote, restate, or paraphrase this note; call no tools.]`,
          };
        }
        if (proximate && dEff > REACH_FT * 2) {
          return {
            code: 'earshot',
            reason: `${npc.name} placed beside/behind ${pc.name} but is ${dFt} ft away`,
            corrective: `[COHERENCE: ${npc.name} is ${dFt} ft from ${pc.name} — not beside or behind them. Rewrite so ${npc.name} is at their real distance (${dFt} ft), or move them close first. Rewrite the WHOLE reply as scene narration in your normal voice — do NOT quote, restate, or paraphrase this note; call no tools.]`,
          };
        }
      }
    }
  }
  return null;
}
