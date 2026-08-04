# SPATIAL TRUTH — the deterministic spatial-interaction engine

> Adopted design, 2026-07-12. Produced by a 4-lens architecture panel (simulation purist / 5e rules
> lawyer / systems pragmatist / LLM-orchestration) + 2 adversarial critiques (feasibility, play-feel),
> synthesized. DM-track owned; zero scene-track changes required for v1.
> **Problem (product owner, verbatim spirit):** "We need a deterministic map of EVERYTHING — exact
> locations, distances, walkable paths; a locked door blocks; crossing water means swimming — can this
> rogue swim, does it roll, how long does it take? In combat this is capital. The wizard water-walks
> across the pool; the rogue must swim. Validate, and TELL the DM where things are and what they are."

## 0. The one-paragraph architecture

All the geometry we need **already exists as bytes** in the frozen `SceneMap` (terrain tags, walkable
grid, wall tiles, roof polygons, platform props, exact col/row for everything). What's missing is not
a world model — it is (1) an **ORACLE** that derives answers from those bytes (distance, path, medium,
room, sight), (2) a single **TRAVEL GATE** in front of `applySceneDeltas` that every actor move — DM
tool, token-truth backstop, raw `updateScene` moves, combat — must pass through, and (3) a **rules-truth
side-table** in `GameState` for the few facts bytes can't hold (locks, movement-altering effects).
The LLM's job collapses to the three verbs it's good at: *relay the situation as fiction, collect the
player's choice, narrate the engine's verdict* — the same suspend-and-verdict loop dice already use.

```
frozen SceneMap bytes ──derive──▶ SpatialIndex (cached, versioned, never persisted)
                                       │ pure queries: distanceFt · findPath · reachableCells ·
                                       │ hasLineOfSight · coverAt · whereIs · areaCells · travelTime
GameState.spatial (persisted, additive) ──▶ interactables (locks) · effects (water-walk, fly)
                                       │
player intent ─▶ DM ─▶ travel()/queryScene() ─▶ ORACLE plans ─▶ gates? ─▶ requestRoll (existing)
                         │ (or: backstop / raw move / combat — SAME gate)        │
                         ▼                                                        ▼
                 applySceneDeltas (still the ONLY mutator) ◀── verdict packet {facts[]} ─▶ narration
```

## 1. Hard design rules (the constitution — each one earned by a failure mode)

1. **Derive, don't store.** The `SpatialIndex` is rebuilt from frozen bytes (<1ms at 6k cells) on a
   version bump from `applySceneDeltas`. No memoized sub-caches (the desync bug class is made
   unconstructible). Zero `SceneMap` schema changes in v1 — every already-frozen map in every saved
   GameState gets the full engine with no migration.
2. **One choke point.** `travel()` guards actor movement for *everyone*: the DM tool, the af12a15
   movement backstop, raw `updateScene` move deltas (rerouted engine-side), and combat. The LLM calling
   the tool is the happy path, **never the guarantee** — repo history (af12a15) proves prompt-hope fails.
3. **Single-shot travel, options-on-block. One gate per call.** `travel` executes immediately when the
   path has zero gates or exactly one viable option (unlocked doors auto-open; shallow water is free —
   *triviality is core architecture, not a mitigation*). It returns a blocked-verdict **with priced
   options** only when ≥2 genuinely viable choices exist; the player's choice arrives as the next call.
   A multi-gate path stops at the FIRST gate. This kills the two-phase plan/commit protocol (stale-plan
   class), the nested-suspension class, and the trivial-move slog in one stroke.
4. **`pendingTurn` remains the ONLY suspension state.** Gates parameterize the existing
   `requestRoll → submitRoll → resolveCheck` machinery. No second suspension system, ever.
5. **Locks are rules truth in `GameState.spatial.interactables`** (typed, validated, schema'd) — never
   free-form `MapObject.state` conventions (which fail **open**, the worst polarity for a lock). The
   engine mirrors open/closed to the fixture via a normal `setState` delta so the renderer stays
   truthful. Single write path; engine writes both.
6. **Frontier degrade.** Every refusal moves the actor as far as legally possible and returns a
   narratable reason ("the rogue walks to the bank and stops"). Never a flat no.
7. **Fail-forward gates.** Every check-bearing gate carries an engine-owned failure consequence —
   displacement (swept 15 ft downstream), time + world advance, noise, position — set per gate type.
   No free-retry no-progress gates (a retryable binary gate is a slot machine, not a scene).
8. **Rule of cool gets an API.** `improvise`: the DM proposes {ad-hoc check, engine-validated
   destination, cost/consequence}; the oracle validates the destination and prices it; the engine
   executes. "I swing from the chandelier onto the balcony" is hosted, not refused.
9. **Ambiguity returns a clarify-verdict, never a confident wrong plan.** Two doors and a vague "I head
   for the door" → the engine asks, it does not deterministically march the token 40 ft the wrong way.
10. **The enforcement dial is first-class.** *Exploration mode* (default): the oracle informs and
    prices; only locked portals and impossible media refuse; no budget policing, no OA enforcement.
    *Combat mode* (flipped by the existing `startEncounter`/`startCombat`): hard movement budgets,
    reach/range legality, OA surfacing. Same oracle, different posture.
11. **OA is a surfaced event** the DM chooses to invoke (`provoked[]` in the verdict), reaction-gated,
    NPC side auto-rolled by default. Never a mid-path suspension interrupt (pacing poison).
12. **Digest carries the common case; coordinates never enter the prompt.** ~10–15 lines of relations
    in FEET and bands ("marin: 25 ft NE, across the pool · door of bldg:jail: LOCKED"). Pull tools
    exist for detail, but a DM that never calls them still knows the tactically live facts — pull-tool
    round-trips cost a full model leg each, so the digest must make them rare.
13. **Tool budget: +2.** `travel` and `queryScene` (asks: `distance | path | los | medium | whatIsNear`
    — the path ask is the free **preview/dry-run**: "can this rogue swim it, how long" before anyone
    commits, which is also the anti-retcon mechanism). `improvise` joins at its rung. We are at 41
    tools and the DM already misroutes; +8 would be fatal.
14. **`facts[]` on every verdict** — atomic, quotable oracle assertions ("the pool is 20 ft across at
    the narrowest crossing"). Facts *constrain* narration, they are not the narration (the exemplar
    corpus owns the voice). A geometry linter (narrated feet must trace to emitted facts) runs in the
    eval harness as a **metric**, not a runtime muzzle.
15. **DC hygiene (playbook):** options are narrated as fiction ("the lock looks pickable; the hinges
    are old"), numbers are never spoken to players. Gate packets live in tool results only.
16. **Whole-mechanic-or-nothing.** Light/darkvision ship together WITH the LOS-reveal rung or not at
    all (walls-block-sight-but-darkness-doesn't reads as broken world logic). Elevation: punted. World
    clock: v1 *reports* durations but persists no clock — a clock nobody advances contradicts narrated
    time and the engine "winning" that argument at the table reads as a bug (clock ships only when
    expiry + dawn-recharge ship with it).
17. **Kill switch:** `MYTHWEAVER_SPATIAL=off` degrades byte-exactly to today's behavior.
18. **Engine owns every number** — including thieves' tools proficiency (through the sheet machinery,
    NOT a DM-declared `unmodeledBonusMax`).

## 2. Data model (v1)

**Derived, never persisted** — `packages/engine/src/spatial/` (new module):

```ts
type Medium = 'ground' | 'difficult' | 'water-shallow' | 'water-deep' | 'wall' | 'void';
interface SpatialIndex {
  locationId: LocationId; version: number;          // bumped by applySceneDeltas
  cols: number; rows: number; feetPerTile: number;  // 5
  medium: Uint8Array;                               // TERRAIN_MEDIUM[tagPrefix] + platform-prop override
  moveCostHalfFt: Uint8Array;                       // 10 = 5ft, 20 = difficult/swim (5e ×2, PHB p.190/182)
  opaque: Uint8Array;                               // walls ∪ catalog tall-props ∪ closed/locked portals
  roomId: Int16Array;                               // flood-fill; -1 = outdoors
  rooms: RoomInfo[];                                // indoor = roofs[] rasterization → buildingId for free
  portals: PortalInfo[];                            // entrances[] ∪ wall-gap door cells; lock joined from GameState
  occupied: Map<number, EntityId>;                  // visible actors
  propAt: Map<number, EntityId[]>;                  // footprint index
}
interface MoveCaps {                                // derived per actor per query — never stored
  speedFt: number;                                  // sheet/statBlock.speedFt (exists, finally load-bearing)
  swim: 'native' | 'double-cost' | 'none';          // optional additive swimFt on sheet/statBlock
  waterWalk?: boolean; fly?: boolean; ignoreDifficult?: boolean;  // from SPELL_MOVE_EFFECTS ⋈ concentratingOn/effects
}
```

**Persisted, additive-optional on GameState** (JSONB-safe; rules truth, not geometry):

```ts
interface SpatialState {
  interactables?: Record<EntityId, {                // keyed by fixture id (doors, gates, hatches)
    open: boolean;
    locked?: { dc: number; breakDc?: number; keyItemDefId?: string };
    barred?: boolean; noisyToOpen?: boolean;
  }>;
  effects?: { combatantId: string; kind: 'water-walk'|'fly'|'spider-climb'|'longstrider'; }[];
}
// state.spatial?: SpatialState — seeded by scenario JSON / arc composer / a setInteractable DM tool
// (mirrors placePoi's shape); absent ⇒ everything open ⇒ today's behavior; POIs share rows via poi.fixtureId.
```

**Static tables** (shared, ~35 rows total): `TERRAIN_MEDIUM` (tag-prefix → medium),
`SPELL_MOVE_EFFECTS` (~10 rows), `CONDITION_MOVE` (grappled/restrained → 0 ft; prone → crawl ×2).
**Prop-catalog flags** (additive, via RFC — these are exactly the `affordances` fields Weave's asset
contracts already plan): `tall?` (blocks sight), `blocksMove?`, `affordances?: ('openable'|'container'|
'climbable'|'surface')[]`. The oracle runs without them (degrade = today); an unknown tag emits a
fidelity ticket + a safe default, and the catalog gets a human ASCII-overlay sweep before any gate
fires in play (the only defense against *confident absurdity* — "Athletics DC 12 to cross the
decorative fountain" is worse for table trust than vagueness).

## 3. The oracle (pure functions, all sub-ms at ≤6k cells)

`buildSpatialIndex(map, catalog)` · `distanceFt(a,b)` (Chebyshev×5) · `findPath(from,to,caps)` (A*,
media-priced edges, locked portals are hard edges, returns segments+doorsToOpen+provokes | blocked
{reason, frontier}) · `reachableCells(from, budgetFt, caps)` (combat preview + backstop targeting) ·
`hasLineOfSight(a,b)` (Bresenham over opaque) · `coverAt(attacker,target)` (DMG corner method →
none/half/¾/full) · `whereIs(id)` ({cell, medium, room, indoor, buildingId, nearestPortal, adjacent})
· `areaCells(shape)` (sphere/cone/line templates → deterministic AoE membership) · `travelTime(ft,
speed)` (rounds in-scene, PHB-pace minutes overland — *reported, not clocked*).

## 4. The interaction pipeline — worked scenarios

**THE POOL** (the founding scenario). 20-ft `water_deep` band before the altar.
- Wizard: casts *water walk* → existing `startConcentration` + `spendResource`; `spatial.effects` row
  appended. `travel(pc:wizard → near:altar)`: caps.waterWalk prices water as ground → 40 ft, no gate,
  executes. Verdict: `{moved, ft:40, timeRounds:1, facts:["the pool is 20 ft across…"]}`.
- Rogue, calm water: swim = double-cost → 20 ft costs 40 → 2 rounds at speed 30. No roll (calm). Moves.
- Rogue, storm flagged: gate fires → `requestRoll` (Athletics vs DC 12, engine-owned modifier) →
  declared 9 → fail → **fail-forward**: moved to the frontier (the bank) *and* swept 10 ft downstream,
  1 round lost. Retrying identically is a different position now — no slot machine.
- One pool, three truths, zero numbers invented by the LLM. A 3rd-level slot visibly buys something
  on the table — this is where determinism is *fun*.

**THE LOCKED DOOR INTO COMBAT.** `travel(pc:rogue → npc:captive)` hits the jail door; interactables
row `{open:false, locked:{dc:15, breakDc:17, keyItemDefId:'iron-key'}}` → blocked verdict, frontier =
at the door, options: pick (Sleight of Hand vs 15, requires thieves' tools — checked against
inventory, resolved through the sheet), force (Athletics vs 17, `noisy`), key (party lacks it —
`available:false, why`). Player picks → declared 17 → success → engine flips the interactable, mirrors
`setState {door:'open'}` to the fixture (renderer swings the door), bumps the index version — the
door cell goes passable *and transparent*, and the two `visible:false` guards behind it are revealed
**as an engine event the DM narrates** (emergent drama, not authored drama — the reveal pipeline is
the biggest pure play-improvement in the design). Fight starts → `startEncounter` flips the
enforcement dial: ActionEconomy (the dead field at domain.ts:214 comes alive) resets per turn;
movement budget debits real path costs; Dash adds budget; guard behind a `tall` crate → `coverAt` =
half → +2 folded into the effective AC engine-side; leaving reach without Disengage → `provoked[]`
surfaced, DM invokes, reaction debited.

## 5. What the DM sees (and can no longer hallucinate)

Digest block (~10–15 lines, feet and bands, zero coordinates):
```
=== MAP (authoritative) ===
Location loc:hollowmere-shore — village, dusk. Party: on the jetty (outdoor).
pc:aldric — 5 ft W of pc:elara · pc:pip — 10 ft S, at the waterline
npc:marin "Marin" — 25 ft NE of party, at the boathouse door · mob:drowned ×4 — 40 ft E, in the water
door of bldg:boathouse: CLOSED · pool: deep water, 20 ft band, between party and the weir
[combat] aldric: 30/30 ft, action ✓ — reachable: drowned-1 (melee), drowned-2 (dash only)
```
Prevention beats correction: ambient truth from turn 1 + free path-preview means the DM never narrates
"the courtyard sprawls, Marin barely visible in the distance" when the oracle says 25 ft — the class
of *engine-publicly-overrules-the-narrator* retcons (which read as bugs, not rigor) is starved at the
source. Playbook adds two paragraphs: narrate-from-truth, and DC hygiene (§1.15).

## 6. 5e bindings shipped in v1 (cited, tested, nothing else)

Difficult terrain ×2 (PHB p.190) · swim without a speed ×2 + Athletics only in rough water (p.182) ·
cover none/half/¾/full via DMG corner method (p.196, folded into effective AC engine-side) · OA on
leaving reach, reaction-gated (p.195) · ranged normal/long bands → disadvantage/refuse (p.195) ·
lock pick/force/key triad with DMG default DCs. **Explicitly NOT v1** (each a whole-rung-or-never
later): jump distances, carry/drag clamps, creature-granted cover, 5-10-5 diagonals, 2014/2024 flags,
darkvision/light (ships whole with the reveal rung), elevation/flight, world clock, group moves.

## 7. Build ladder (each rung independently valuable; falsify before climbing)

- **R0 — Falsify the derivation (≤1 day, throwaway).** `buildSpatialIndex` over every frozen
  dev-session map + 50 generator seeds: rooms close (no flood leaks), media cover all tags, paths
  exist or are explainably blocked, build <2 ms. Plus **bit-parity**: empty catalog ⇒ passability
  byte-identical to `walkable[][]`. Plus the human ASCII-overlay sweep on the-drowned-bell.
  *Gate: >5% leaky rooms → fix derivation (or demand a scene-track wall-closure invariant) first.*
- **R1 — Oracle + digest + `queryScene` (read-only).** This alone kills hallucinated geography.
  *Gate: eval — narrated distance/blocking claims trace to oracle facts on scripted turns. Measure
  before anything writes.*
- **R2 — `travel` out of combat.** Media gates, swim pricing, frontier degrade, fail-forward
  consequences, time reporting; backstop + raw-move reroute. *Gate: the pool scenario plays verbatim
  in the DM Lab.*
- **R3 — Interactables.** `spatial.interactables` + `setInteractable` + lock triad + POI `fixtureId`
  wiring + renderer mirroring. *Gate: the locked-door scene, all three options.*
- **R4 — Combat spine.** ActionEconomy live, budget clamping with partial progress, Dash/Disengage,
  reach/range legality (`inRange` precheck on attack requestRolls), OA surfacing, `improvise` tool.
  *Gate: a scripted encounter where every movement number is engine-attributable; re-pin evals.*
- **R5 — Cover + AoE.** Corner method into effective AC; `areaCells` targeting.
- **R6 — Light + vision + reveal, whole.** Bright/dim/dark, darkvision, LOS-driven reveal events,
  per-building roof reveal. *(A separate proposal with its own falsification — stop and reassess here.)*

## 8. Boundaries & coordination

- **Scene track: zero changes required for v1.** The oracle reads frozen `SceneMap` bytes (their
  published contract) and writes only through `applySceneDeltas`. Runtime truth (this doc) and
  generation-time truth (Weave claims grid) are views over the SAME bytes — no second store. Two
  additive RFCs when convenient: prop-catalog affordance flags (converges with their asset contracts),
  and a wall-closure invariant if R0 finds leaky rooms. If Weave later encodes passability semantics
  (ruined bridge), the oracle consumes them as better *inputs* behind the same query signatures.
- **Blob discipline:** no persisted plans, no per-cell paths in GameState, `pendingTurn` untouched.
- **Failure containment:** kill switch; unknown tags degrade safe + ticket; oracle failure never
  breaks a turn (same fail-open posture as exemplar retrieval).

## 9. Top risks (owned, not hidden)

1. **Derivation quality on messy maps** (leaky wall loops merge indoor/outdoor) — R0 exists to catch
   this before anything is built on top.
2. **Confident absurdity** (render tags were authored for art, not physics) — catalog sweep + safe
   defaults + fidelity tickets; deterministic-but-wrong is worse than vague.
3. **DM routes around the loop** — engine-side reroute caps the damage (structural, not prompt-hope);
   eval-gated at R1/R2, not discovered at R4.
4. **Gate fatigue** — the triviality threshold and one-gate-per-call are the pacing contract; if the
   table ever feels like a pathfinding dialog box, the threshold is wrong, not the players.
5. **Scope gravity** — every rung tempts full 5e fidelity; the whole-mechanic-or-nothing rule and the
   R6 stop-line are the defense. A mechanic that fires 60% of the time destroys player prediction
   worse than its absence.
