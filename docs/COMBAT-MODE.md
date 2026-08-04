# COMBAT MODE — strict turns on the live table

*Analysis + plan, 2026-07-30. Status: PROPOSED (awaiting greenlight). Companion to
docs/MythWeaver-Dev-Spec.md §4 (the engine ramp), docs/INTERACTION-LAYER.md (the gate doctrine),
docs/PLAYER-INTERFACE.md (the table the UI lands on).*

---

## 0. TL;DR

Combat today has initiative **in name only**: `startEncounter` rolls an order, and then nothing reads
it — `Engine.nextTurn()` has existed since P2 and has **zero callers**, `ActionEconomy` is declared on
`Combatant` and **nobody sets or spends it**. Aldric can attack five times in a row while three bandits
watch politely, because every mechanical restriction lives in the playbook's prose and prose drifts
(this week alone: the roll gate, the reach gate).

The fix follows the house doctrine proven seven times in this repo: **the engine owns the rule, a
deterministic gate enforces it at a choke point, the LLM narrates the verdict.** Combat mode is not a
new system — it is wiring the half-built one to the gates it was always spec'd to have (§4.2 P2:
"initiative order, the full action economy" engine-authoritative), plus the UI that makes turn state
legible: an initiative rail, action pips, an End Turn button, movement-range preview.

Five slices, C0–C4. C0+C1 make combat *correct* (engine spine + orchestrator gates + auto-resolved
enemy phase). C2 makes it *playable* (the UI). C3+C4 make it *rich* (death-save drama, reinforcements,
grouped ally turns, reactions). Each slice is independently falsifiable and ends with a live drive on
the `roadside-ambush` fixture.

---

## 1. Where we actually are (evidence, not vibes)

**Exists and works** (P2/P3 ramp):
- `CombatState {active, round, turnIndex, order}`; `startCombat` sorts initiative; `startEncounter`
  spawns from the authored encounter, rolls `1d20 + initiativeBonus` per combatant, pops tokens onto
  the map near the party (engine-owned spawn deltas).
- `applyDamage` (resist/immune/vuln, temp HP, downed at 0, death-save failure on hitting a dying PC),
  `heal`, `rollDeathSave` (3F = dead, 3S = stable, nat 20 = up), `applyCondition` (+immunities),
  concentration checks on damage, spell slots, XP/levels (`awardXp`, milestone), inventory/economy.
- `maybeEndCombat`: fight auto-ends when no conscious enemy remains; `endCombat` despawns NPCs.
- Spatial truth: `travel` walks real paths; the **reach gate** (S1–S7) already refuses out-of-reach
  attacks, auto-approaches when movement could close the gap, and carries `attackerId` on `applyDamage`.
- The roll bar: `requestRoll` suspends the turn (`pendingTurn`), player declares physical dice, engine
  validates plausibility and judges vs DC/AC.

**Declared and dead** (the gap):
- `Engine.nextTurn()` — never called. `combat.turnIndex` is frozen at 0 forever.
- `ActionEconomy {action, bonusAction, reaction, movementRemainingFt}` — never seeded, never spent.
- `resolveAttack` — `throw new NotImplemented('resolveAttack', 'P1')`.
- No XP-for-CR table (awardXp takes hand-fed amounts, so nobody awards it).
- No loot on kill (loot is POI-only; monsters aren't POIs).
- Nothing stops any speaker acting at any time; monster "turns" happen only if and when the DM feels
  like narrating them inside a player-triggered reply.

**Spec intent** (§4.2, table row P2): initiative order and the full action economy are supposed to be
engine-authoritative *since the combat phase*. This plan is closing spec debt, not inventing scope.

---

## 2. The shape of the problem

Combat differs from every layer built so far in one way: **it inverts the driver.** Everywhere else,
the player speaks and the world answers. In combat, the *order* speaks: the world takes turns acting
between player inputs, uninvited. That forces four architectural questions:

1. **Who enforces the order?** (The engine — a playbook rule would be the third prose-drift casualty
   this week.)
2. **Who plays the monsters?** (Today: the LLM, incidentally, inside player-turn replies. That can't
   survive strict turns — see §3.3.)
3. **What is "a turn" over the wire?** A PC turn is not one HTTP round-trip: attack roll suspends,
   damage roll suspends again. Turn advancement must be explicit (`endTurn`), never inferred from
   request boundaries.
4. **What may non-active players do?** (Answer: talk is free, mechanics are gated — §3.5.)

---

## 3. Design decisions

Each decision names the alternatives, what the reference games do (BG3 = Baldur's Gate 3, Solasta =
the most RAW-faithful CRPG, Foundry = the VTT baseline), the choice, and why.

### 3.1 Turn strictness: STRICT single-combatant turns first, allied blocks later

- *Options:* (a) fully strict per-combatant (Solasta, RAW); (b) BG3-style grouped initiative —
  consecutive allies in the order act in any sequence among themselves; (c) side-based phases
  (players-then-monsters, older JRPG style); (d) soft "DM suggests order".
- *Decision:* **(a) strict in C0–C2, upgrade to (b) blocks in C3.** Side-based (c) throws away rolled
  initiative and changes 5e balance (alpha-strike parties); soft (d) is what we have and it failed.
  Blocks are the right end state for a shared screen — when Aldric and Pip are adjacent in the order,
  forcing a fixed sequence between them is pure friction — but blocks complicate "whose turn" state,
  and the spine should be provably correct before it gets clever. The engine models blocks as a
  contiguous run of PC entries; single-PC blocks make (a) a special case of (b), so C3 is additive.

### 3.2 Enforcement point: engine verdicts + one deterministic orchestrator gate

- The engine gains `turnGuard(combatantId)` — refuses any economy-spending mutation
  (`applyDamage(attackerId…)`, `travel`, casting) from a combatant who is not active, with a
  narratable reason (`not-your-turn`, whose turn it is). This is the deep defense: even a confused
  LLM tool call cannot break order, exactly like the reach gate.
- The orchestrator gains a **pre-LLM gate**: in active combat, a `message` from a speaker who isn't
  the active PC is refused *before any model call* — $0, instant, with `{activeName, round}` so the
  client can render "It's Elara's turn" without a round-trip. (House precedent: the speech-act gate
  runs pre-LLM the same way.)
- The playbook gets a COMBAT MODE section, but as *narration guidance*, never as the enforcement.

### 3.3 Monster turns: engine-resolved policy, one narration call per enemy phase

- *Options:* (a) LLM takes each monster turn via tools (status quo flavor, formalized); (b) engine
  resolves monster turns with a deterministic tactical policy and rolls its own dice, then **one** LLM
  call narrates the whole enemy phase; (c) hybrid — policy resolves, but boss-flagged monsters get an
  LLM turn.
- *Decision:* **(b), with (c)'s hook reserved.** Three reasons. **Numbers:** "the engine owns every
  number" — a monster's attack roll is the DM's die, and our DM's dice *are* the engine's RNG (players'
  physical dice stay sacred for player rolls only; this matches RAW where the DM rolls for monsters).
  **Latency/cost:** with gpt-5.6-luna at 20–60 s per call, three monster turns as three LLM calls is a
  three-minute enemy round; as engine resolution + one narration call it's one. **Drift:** an LLM
  playing three bandits re-invents positions and forgets HP; the policy reads the oracle.
- *The v1 policy* (per monster, in initiative order): if a living PC is in reach → attack (engine
  rolls attack vs AC, damage on hit, crits on nat 20); else path toward the nearest reachable PC
  (`findPath`, spend movement) and attack if now in reach; ranged monsters attack from ≤ their range
  and step away from adjacent PCs first (no OA in v1 — see §7). Facts stream out exactly like
  reaction/MEANWHILE facts do today; the narration call receives them as verdicts to voice, subject to
  the same "narrate the verdict, never overturn it" law and gates.
- Every enemy-phase fact rides the existing pipelines: transcript, `journalVerdicts` (Book), deltas
  (tokens actually move on screen), witnesses.

### 3.4 Action economy v1: action + bonus action + movement; reactions deferred

- Seed `actionEconomy` for every combatant at `startCombat` and refresh at the top of their turn:
  `{action: true, bonusAction: true, reaction: true, movementRemainingFt: speedFt}`.
- Spend at existing choke points — no new tools: an attack (`applyDamage` with `attackerId`, or the
  suspended roll that leads to it) spends `action` at the *moment the attack roll is requested* (a
  miss still spends the action — RAW); `travel` decrements `movementRemainingFt` by actual path feet
  (the travel gate already computes them); casting a levelled spell spends `action` (bonus-action
  spells: the slots machinery knows the spell — C3); Dash = the DM narrates it, engine `dash()` trades
  the action for +speed movement. Refusals are verdicts: `no-action-left`, `not-enough-movement
  (need 20 ft, have 10)`.
- **Reactions/opportunity attacks are C4, deliberately.** OA is the single biggest rules-surface in
  melee 5e, touches the travel gate, needs interrupt semantics, and the v1 monster policy simply
  doesn't kite (so the missing OA can't be farmed). Shipping economy without OA is how BG3's own
  early access did it, for the same reason.

### 3.5 Non-active players: mechanics gated, speech cheap, UI honest

- The pre-LLM gate bounces *mechanical* inputs from non-active speakers. v1 bounces **all** inputs
  from them (a shared screen makes this nearly free: the dropdown auto-follows the active PC and the
  Say button disables for others, so the refusal is almost unreachable). If mid-combat banter is
  missed in play, v1.5 lets non-active text through flagged `[table talk — no tools, one sentence]`.
  Talking on *your own* turn is free (RAW).

### 3.6 Turn end: explicit, never inferred

- `End Turn` button (client) → `endTurn` API field → `engine.endTurn(pcId)` → `nextTurn()`. Also
  detect the literal text "end turn". No silent auto-advance when economy hits zero — bonus actions
  and talking exist; instead the UI pips make "you're spent" obvious and the DM's narration nudges.
  A pending roll blocks `endTurn`/`nextTurn` (you cannot leave a die in the air).
- After a PC ends their turn, the server *immediately* runs the enemy phase for every consecutive NPC
  in the order (one engine pass + one narration call) and returns with the next PC already active —
  one round-trip delivers "your bandit dies, the other two act, Elara is up".

### 3.7 Whose dice: players roll players' dice, the engine rolls the world's

Unchanged for PCs (the roll bar is the product's soul). Monster attack/damage/saves: engine RNG,
logged in the trace, narrated as verdicts. Death saves are PLAYER rolls (see §7 — they're the most
dramatic die in 5e and belong in the player's hand via the roll bar).

### 3.8 Enemy health display: qualitative words, not bars

BG3 shows exact enemy HP bars; Solasta shows states. We show **states** — `unharmed / wounded (<100%)
/ bloodied (<50%) / near death (<25%)` — as ring color + word on the initiative rail and hover. This
respects the table's own law (the player payload carries only what play surfaced; exact monster HP is
authored truth) and it's *better D&D*: "how hurt is it?" is table texture. Party chips show exact HP
(players know their own bodies). The projection ships the state word, never the number.

### 3.9 Damage attribution, XP, loot (the "who gets credit" cluster)

- **Attribution:** `applyDamage` already carries `attackerId`; the engine stamps `downedBy`/`slainBy`
  on the victim and emits the verdict fact ("Pip fells Bandit 1") → journal (with witnesses) →
  dossier deeds. Enemy-phase damage attributes to the monster the same way ("Bandit 2 opens Aldric's
  arm — 5 slashing").
- **XP:** add the SRD XP-by-CR table to `progression.ts` (`xpForCr(cr)`; CR 1/8 = 25 XP …). On
  victorious `endCombat`, the engine sums defeated CR-XP and **splits evenly across surviving+dying
  PCs** (RAW-style; per-kill XP invites kill-stealing and punishes support play). `awardXp` already
  handles level-up availability; the existing level-up surfacing takes it from there. Fled enemies
  award half (they were beaten off).
- **Loot:** on victory, each dead (not fled) enemy becomes a **body POI** at its last cell —
  `placePoi(kind:'body', look:"Bandit 1's body", contents: from the stat block's loot or a CR-based
  coin/gear table, discovered: true)`. This reuses the entire proven POI → search → Findings → Book →
  witness pipeline for zero new UI, and bodies persist in the scene (fiction-correct). `endCombat`'s
  NPC despawn already removes the tokens; the body POI is the corpse.

### 3.10 UI (C2) — the BG3 borrowings that fit a text-first table

- **Initiative rail**, top-center over the canvas: one chip per combatant in order — `Portrait`
  (the person's own map sprite, same component the Book uses), name, active = gold ring + slight
  scale + the canvas token pulses (the double-ring affordance already exists), downed = grayed +
  skull, enemies get the §3.8 health color. Round counter at the left end. Rail comes from a new
  player-safe `combatView` block in `/player-view` (order, active, round, per-chip word — no numbers
  for enemies).
- **Action pips** beside the Say box when it's your PC's turn: ⚔ action · ✦ bonus · 🥾 `n ft`. Grey
  out as spent (server truth, not client guess).
- **End Turn** button next to Say (primary-colored when you're spent).
- **Turn banner**: the existing beat title-card machinery, reused small — "Round 2 — Elara" on each
  block change; big card on round change only (avoid strobing).
- **Grid + range**: during combat, a subtle grid overlay on the canvas; on your turn, tint the cells
  reachable with remaining movement (oracle BFS with the mover's caps — cheap at 40×26). Attack-range
  ring around your token on hover of an enemy chip (v1.5). This is `SceneCanvas` work — additive
  props, same discipline as `onInspect`.
- **Speaker auto-follow**: the dropdown snaps to the active PC at each turn change (still editable —
  refusals answer instantly and free).
- *Deliberately not copied from BG3:* camera takeover per actor (one shared screen — the existing
  focus-framing already frames the fight), surfaces requiring mouse-targeting to act (text stays the
  action channel; clicking is inspection/ping).

---

## 4. Architecture

### 4.1 Engine (packages/engine) — the turn spine

```
CombatState (unchanged shape; semantics now enforced)
Combatant.actionEconomy      — seeded at startCombat; refreshed by refreshEconomy(id) at turn start
activeCombatant()            — order[turnIndex] (helper)
turnGuard(id)                — verdict {ok} | {refused: 'not-your-turn', active, round}
spendAction(id) / spendBonus(id) / spendMovement(id, ft)   — verdicts, never throws into a turn
endTurn(id)                  — guard: id must be active, no pendingTurn; → nextTurn()
nextTurn()                   — EXISTING, finally called; refreshes the new active's economy;
                               upkeep hooks (concentration already event-driven; conditions v2)
insertIntoInitiative(id, initiative)   — C3, reinforcements
removeFromInitiative(id)     — flee/despawn keeps order sane (splice + index fix)
xpForCr(cr) in progression.ts; endCombat(victory?) → awards XP, plants body POIs, emits summary facts
```
Everything is verdict-shaped (`{ok:false, reason, …}`) like reach — refusals are narratable, never
exceptions that eat a turn.

### 4.2 Orchestrator (apps/server) — three insertions, no rewrite

1. **Pre-LLM combat gate** (top of `runTurn`, message inputs, combat active): speaker ≠ active PC →
   return a canned TurnResult (no cost, no LLM) with the whose-turn payload.
2. **Choke-point spending**: the `requestRoll`-for-attack site spends the action; the travel site
   spends movement (it already knows path feet); refusal verdicts ride back through the existing
   tool-result path so the DM narrates them ("you've already swung this round").
3. **Enemy-phase runner**: on `endTurn` (and on combat start if monsters precede the first PC):
   `while (active is NPC): resolveMonsterTurn(policy)` → collect facts + deltas → ONE narration call
   (gates apply: polarity/coherence/roll) → hand back with the next PC active. `maybeEndCombat`
   already terminates the loop when the last enemy drops mid-phase.

`dmLabSubmit`/routes: `{ endTurn: true }` input variant; `/rev` + view payloads gain `combatView`.

### 4.3 The wire (a full round, worst case)

```
Pip's turn:  POST {say:"I stab Bandit 1"}      → action spent, roll suspends        (1 LLM call)
             POST {roll:18}                    → hit, damage suspends               (1)
             POST {roll:7}                     → damage lands, fact journaled       (1)
             POST {endTurn:true}               → enemy phase: 3 bandits resolved
                                                 engine-side, one narration,
                                                 "Elara is up"                      (1)
Elara out-of-turn guard tripped by Aldric      → instant refusal                    (0)
```
Four model calls where today's un-ordered chaos spends three per *player action* and still lets the
world skip its turn. Latency per enemy phase ≈ one call regardless of monster count.

### 4.4 Player view (fail-closed, as always)

`combatView = {round, activeId, order: [{id, name, kind, healthWord, downed, isActive}]}` — composed
server-side from engine state; enemy `healthWord` derived, numbers never shipped; the secret-scan
gains a planted-marker case (exact monster HP must not appear in any player payload).

---

## 5. Restrictions — what happens when a player tries X

| Attempt | Enforcer | Outcome |
|---|---|---|
| Act on someone else's turn | pre-LLM gate | instant refusal, $0: "Round 2 — it's Elara's turn" |
| Second attack same turn | `spendAction` verdict | DM narrates: the action is spent (level-1 party has no Extra Attack; the field exists for level 5) |
| Move farther than speed | travel gate + `spendMovement` | walk clamps at budget; verdict names the shortfall |
| Attack out of reach | **existing** reach gate | auto-approach if movement allows (now *spending* that movement), else refused with the gap |
| Cast without a slot / unknown spell | **existing** P3 slot machinery | refused with reason |
| Something impossible (level-1 Wish) | **existing** playbook edge-case rules | narrated refusal, no roll |
| A task longer than a turn ("I pick the lock while they fight") | v1: DM rules it takes N rounds, the action is spent each round, progress narrated; C3 formalizes `channeling {label, roundsLeft}` on the combatant (reusing the concentration interrupt: damage forces the check/breaks it) | partial progress is real, interruptible, and honest |
| Flee the fight | allowed — travel off the encounter area → `removeFromInitiative`, morale note in C3 | the world doesn't railroad |
| Talk / free interaction | free on your turn; v1 bounced off-turn (UI makes it moot) | RAW-ish |
| "I ready an action / overwatch" | C4 (reactions) | until then the DM narrates it as fiction without a mechanical trigger |

---

## 6. Edge cases with committed answers

- **Dying PC's turn:** on `nextTurn` landing on a downed PC, the server auto-issues the death-save
  `requestRoll` (1d20, no modifier) — the player rolls their own fate on the roll bar; engine
  `rollDeathSave` semantics already complete (stable/dead/nat-20-up). No action economy while dying.
- **Everyone down (TPK):** `maybeEndCombat` only ends on enemy wipe; a party wipe ends combat with
  `victory:false` — no XP, no bodies looted, the Director owns the aftermath beat (out of combat-mode
  scope, flagged to the arc layer).
- **Reinforcements mid-fight:** C3 `insertIntoInitiative` (rolled on arrival, slots after the current
  index — RAW). The living-world reinforcement dispatch (P4f knights) becomes the caller.
- **Combat starting with monsters first in order:** the enemy-phase runner fires immediately after
  `startEncounter`'s reply — the ambushers *actually strike first*, which the current fixture fakes.
- **Pending roll + anything:** `pendingTurn` blocks `endTurn`, blocks the gate from advancing, blocks
  freeze-with-pending edge (already survives via PendingTurn persistence).
- **Mid-combat freeze/reload:** all new state (economy, turnIndex use, channeling) lives on
  `GameState` — the dev-session freeze carries it for free; `build-combat-fixture` re-freezes with a
  PC active by construction (its audit already asserts this).
- **Non-combat tools during combat:** small deny-list at the tool layer — `advanceScene`
  (unless the party fled), `shortRest`/`longRest`, `travel` beyond the map — refused with reasons.
- **Legacy saves without economy fields:** all additive/optional; `startCombat` seeds them; old
  fixtures re-enter combat mode correctly on the next `startEncounter`.

---

## 7. What is explicitly OUT (and when it returns)

| Cut | Why | Returns |
|---|---|---|
| Reactions / opportunity attacks | biggest rules surface; interrupt semantics; v1 monster policy doesn't kite so it can't be farmed | C4 |
| Surprise rounds | needs the stealth/witness integration end-to-end | C4+ |
| Grouped ally blocks (BG3 rule) | spine first; additive on top of strict | C3 |
| Condition durations (1-minute spells etc.) | duration bookkeeping is its own slice; conditions currently toggle | C4 |
| Per-monster LLM "boss turns" | cost/latency; hook reserved in the phase runner | when a boss needs it |
| Multiattack (CR 1+ monsters), Extra Attack (PC lvl 5) | party is level 1; fields exist in stat blocks | with the level ramp |
| Click-to-move / click-to-target | text stays the action channel; clicking is inspection | v1.5 UI |

---

## 8. Phasing (each slice falsifiable, live-driven on `roadside-ambush`)

**C0 — the engine turn spine** *(pure engine + tests, no behavior change until C1 wires it)*
Economy seeding/refresh/spend; `turnGuard`/`endTurn`/`activeCombatant`; `nextTurn` pendingRoll guard;
`removeFromInitiative`; `xpForCr` table; `endCombat(victory)` → XP split + body POIs + summary facts;
`downedBy/slainBy` attribution. **Exit:** unit tests prove a scripted round (spend→refuse→endTurn→
wrap→refresh; kill→XP→bodies); freeze/reload byte-identical.

**C1 — orchestrator gates + enemy phase** *(combat becomes real)*
Pre-LLM speaker gate; choke-point spending on the attack-roll and travel sites; enemy-phase runner
(policy + engine dice + ONE narration under the existing gates); `endTurn` input; combat-end
aftermath (facts → journal/scribe/chronicler untouched — they already listen); playbook COMBAT MODE
section; eval cases (out-of-turn refused; enemy phase acts; second attack refused).
**Exit:** on the fixture — Pip attacks, ends turn, *bandits actually act and hurt someone*, Elara's
turn arrives; an out-of-turn Aldric line is refused in <100 ms for $0.

**C2 — the combat UI** *(playable at the table)*
`combatView` in player payloads (+ secret-scan marker for enemy HP); initiative rail with portraits/
health words/active glow; action pips; End Turn button; speaker auto-follow; turn banner; grid
overlay + movement-range tint on your turn; token pulse on the active combatant.
**Exit:** screenshot review of a full played round; poll keeps rail in sync from a second browser.

**C3 — flow upgrades**
Death-save auto-prompt on a dying PC's turn; reinforcements (`insertIntoInitiative` + P4f dispatch
wiring); flee handling + simple morale (bandits break at ≤ half numbers — persona-driven);
grouped-ally blocks; formal `channeling` for multi-round tasks.
**Exit:** scripted drives for each (down a PC and watch the save prompt; knight arrives mid-fight and
slots into the rail; two adjacent PCs act in either order).

**C4 — reactions + polish**
Opportunity attacks (travel gate emits the provocation, reaction spends, engine rolls); readied
actions (minimal trigger grammar); condition durations; adversarial review of the whole mode; regen
the combat fixture frozen mid-round; eval re-pin; memory.

Cost per slice to verify: ~$0.30–0.60 of live drives; the fixture makes iteration $0 after each freeze.

---

## 9. Risks, honestly

- **Latency is the experience risk, not correctness.** A luna narration call is 20–60 s; a round with
  a suspended attack+damage is 3–4 calls end to end. Batching the enemy phase into one call is the
  big win; if rounds still feel slow, the escape hatches are (a) auto-roll toggle for damage dice,
  (b) routing enemy-phase narration to a faster model (`taskClass` seam already exists).
- **The DM narrating against the turn state** (acting for a monster out of phase, "you may both go").
  Mitigation is structural: monsters only move via the engine phase, and economy verdicts bounce
  anything else; a polarity-style narration gate for "narrated an enemy acting outside the phase" is
  the C4 backstop if drives show drift.
- **Policy monsters looking dumb.** They will occasionally stand in fern instead of flanking. v1
  accepts this (bandits are bandits); the boss hook exists; the policy improves cheaply (focus-fire,
  cover use) without touching architecture.
- **Fixture/back-compat**: old freezes have `combat.active` with `turnIndex 0` and no economy — C0
  seeds lazily; the audit in `build-combat-fixture` already fails a fixture whose active combatant
  isn't a PC.
- **Scope creep magnet**: OA, durations, surprise, readied actions all *feel* adjacent. The cut list
  (§7) is the contract; anything crossing it needs its own greenlight.

---

## 10. Open taste questions (decided, but cheap to flip — say so before C2)

1. Enemy health as **words** (chosen) vs BG3-style exact bars — flipping later is a projection change
   only.
2. Off-turn table talk **bounced** (chosen) vs allowed-as-flavor — flipping is deleting one guard.
3. Monster dice **engine-rolled** (chosen) vs offering the table a "roll for the goblin" novelty
   toggle — flipping adds a suspend path in the enemy phase; don't choose it for v1.
