# The Interaction Layer — MythWeaver P4 (final)

**A PC (or the world) acts → the engine decides who perceives it, how each NPC responds, and moves them → the DM narrates only the engine's verdict.** This generalizes the shipped threat pipeline (`reactions.ts`) into the session's one interaction spine. The central design decision, forced by the red-team: **the One-World guarantee is geometric.** Every safety property the shipped pipeline enjoys rests on the verdict being a *position* the engine owns and `narrationBreaksScene` can check. So the taxonomy splits not by social flavor but by whether an act **casts to a position/ledger-op the engine already owns** (safe) or resolves to **pure speech** (dangerous). We build the first freely and gate the second behind a closed enum and a new polarity predicate. Everything else is reuse.

---

## 1. The Interaction Taxonomy

Two orthogonal cuts. First, a **resolution lane** (the gating mechanism): **Broadcast** (one act, N oracle-derived witnesses, each resolved independently, never suspends), **Directed-social** (one target, resolved by a persona-DC the PC rolls against, may suspend), **Directed-material** (one target, an existing engine op + a standing delta, no new resolver). Second — and this is the load-bearing cut — **movement-shadowed vs pure-speech**:

- **Movement-shadowed acts cash out to ground truth the engine owns** — obey→`travel`, gather→`travel`, gift→economy transfer, raise-alarm→POI/ledger flag, transgress→authority walks to confront. The *existing* gate covers these because the verdict is a position or an economy fact. Build freely.
- **Pure-speech acts have no geometry** — refuse-in-character, believe/doubt, take-offense. These get (i) a **closed verdict enum** and (ii) a **new polarity gate** (§2). Conditional, priced, or lore-bearing speech is a **forbidden output** — the engine can't own those commitments.

| Family | Stimuli | Lane | Appeal (derived) | Gating | Verdict cashes out to |
|---|---|---|---|---|---|
| **Threat** *(shipped)* | attack, menace, brandish | broadcast | fear | perception + persona | `travel`, `promoteToken` |
| **Summon** | "all villagers, come!", bell, alarm | broadcast | authority/curiosity | perception + standing | `travel` to locus / hold |
| **Performance** | music, juggling, harmless flash | broadcast | curiosity | perception + persona | `travel` toward source |
| **Environmental** | fire, open cage, douse lights | broadcast (world) | alarm/curiosity | perception of the world-change | POI toggle → witnesses `travel` |
| **Command** | "Tessa, check the lock" | directed-social | authority/duty | persona-DC ± standing | `travel` (obey) / enum (refuse) |
| **Request/Plea** | "please help", "let us pass" | directed-social | affection/duty | persona-DC | `travel` / enum |
| **Persuade/Intimidate/Deceive** | argue, threaten, lie | directed-social | reason/fear/deceit | persona-DC (deceive vs passive Insight) | `setState` flag / enum |
| **Expressive** | greet, insult, flatter, taunt | directed-social | pride/affection | trivial | **standing delta** + enum |
| **Offer/Bribe/Trade** | offer, gift, sell | directed-material | greed | persona-DC + **economy** | economy transfer + delta |
| **Aid** | heal, rescue, free | directed-material | gratitude | none (engine op) | existing op; standing ↑ |
| **Transgress** | steal, desecrate, trespass | broadcast (neg-threat) | outrage | perception (witnessed?) | `travel` confront; standing ↓ |
| **Presence/Stealth** | sneak, disguise, reveal | *oracle pre-filter* | recognition | Perception/Insight contest | modifies the grade only |
| **Null/Wait** | long idle beat | — | — | — | NPCs advance a standing `rx:goal` |

**Presence is not a lane** — it decides who enters the witness set. **Group-as-target is a lane variant:** a directed act may target a group ref ("Guards, stand down"), resolved per-member but gated as **one ask against one DC**.

---

## 2. The Unifying Architecture

**One pipeline:** `Stimulus → WitnessSet (oracle) → per-NPC Resolution → EngineExecution → VerdictFacts`. This is `resolveReactions`'s exact spine (`gradeOf` witness loop, `MAX_REACTORS` cap, `reacted` de-dupe, `travel(mode:'auto')`, `facts[]`). Only two things are threat-locked today: `reactTo` and the `DisturbanceEvent` kinds. We widen the **mouth** and the **appraisal** — nothing else.

**Extension, not a new subsystem — decisive.** Promote `reactions.ts → interactions.ts` with `resolveInteraction(stimulus)` as the entry; `resolveReactions` becomes the `kind:'threat'` specialization. A parallel orchestration layer would duplicate the witness/persona/travel/verdict spine we are reusing and re-open the coherence-gate contract. The orchestrator stays the id-resolver and roll-suspension owner.

**The two genuinely new pieces:**

1. **`appealTo` — additive, not the rejected multiplicative table.** **Appeal is the primary key**: each appeal pins a default verb (curiosity→approach, authority→gather, outrage→confront, fear→`reactTo`'s threat lane). Persona/temper is a **thin modifier on threshold and approach-distance only** — never a new verb per cell. If the appeal→verb map isn't small, the `stimulus×persona×standing×grade` table has snuck back. **Appeal is derived from `kind`, never an LLM argument** — picking `curiosity` vs `authority` would let the LLM steer who gathers.

2. **The polarity gate — a genuinely new predicate, not an "extension."** Directed-social verdicts are a **closed enum**: `obeyed | refused | feared-into-compliance | believed | saw-through | warmed | bristled`. The gate string-matches the narration's compliance/belief polarity against the enum verdict (obeyed-but-narrated-as-refusing = re-narrate). The DM voices **tone only**; any words committing a resource, condition, or fact are forbidden or routed through an engine op.

Core types (abbreviated): `Stimulus{ lane, kind, source:MapObject|'world', target?, action?:DesiredAction, locus:Cell, tone? }`; `DesiredAction` is a **closed verb set** (`go|operate|fetch|give|fight|hold`) — choosing the verb is *declaration*, like `travel`'s `to`, not an outcome. `report` is **restricted to engine-legible predicates** (POI state, spatial facts, recorded ledger facts); "what did you see in the cellar?" is deflected, not invented.

---

## 3. Reuse of each existing seam

| Seam | Reuse |
|---|---|
| **Witness oracle** (`oracle.ts`) | `gradeOf` builds the WitnessSet verbatim — a shout grades like a sword-stroke. Set is oracle-derived, **never an LLM name list**. Presence modifies the grade. |
| **Personas** (`persona.ts`) | `appealTo` sibling to `reactTo`, pure function of (appeal, persona, standing, grade). No per-NPC loop. |
| **NPC resistance** | **Persona-derived passive DC — the PC rolls once, the NPC never rolls.** `resolveCheck` returns +0 for sheetless map tokens, so an NPC-side roll is degenerate *and* violates thin-personas. Passive DC from archetype/temper/standing fixes both. |
| **requestRoll suspend** (`orchestrator.ts`) | Directed-social acts route through the existing suspend/resume. But `commandContinuation` is **new logic**, not the swim-gate renamed: a PC roll whose *pass* triggers a `travel` on a *different actor*; `pendingTurn` must persist the full `DesiredAction`. |
| **travel** | Every movement verb is `travel(mode:'auto')`. |
| **Ledger** | Standing in `npc:<id>:*` flags, mutated only via append-only `recordFact`. |
| **Verdict-fact binding** | Unchanged for movement-shadowed acts; the polarity gate is the new predicate for pure-speech. |

---

## 4. Standing — one scalar, ledger-owned, carded-cast only

**Standing is meaningful only for named, carded cast** (anonymous crowd tokens have no stable id — broadcast/appeal correctly needs no standing). Keyed by **`(npc, target)`** with `target ∈ {party, faction}` so aiding one member moves faction standing:

```
npc:<id>:standing[target] ∈ {hostile:-3 … sworn:+3}   (seeded from persona.allegiance)
npc:<id>:serves = <faction>     // NPC→authority edge: a guard obeys its captain
npc:<id>:fears  = bool          // fear ≠ love: intimidation compels AND lowers standing
```

Two axes: **like** (standing) and **fear**. `serves` is legitimacy — a command from your authority *skips the roll*; from a stranger it's a check.

**Command DC** — pure function in `interactions.ts` (not `persona.ts`, which has no ledger access; not the LLM boundary):
```
DC = 10 + costTier(action) − 2·standing − authorityBonus + temperMod   clamped [5,25]
   DC ≤ 5 → auto-obey · DC ≥ 25 → auto-refuse · else → requestRoll
```

**Standing mutates only by resolved verdicts** (aid ↑, insult ↓, passed Intimidation sets `fears` and *lowers* standing).

---

## 5. Invariants — the layer MUST enforce all twelve

1. **No outcome as argument.** Tools take stimulus + target; no `outcome`/`obeyed` field exists.
2. **Witness-set closure / no hammerspace.** Reactors only from on-map actors in range. **No spawn verb; no free `worldDelta`** — environmental change goes through POI toggles / pre-placed hazards.
3. **Command ≠ compliance.** Disposition threshold or persona-DC. Refusal and intimidation-fear are first-class verdicts.
4. **Engine-owned standing.** Bounded, carded-cast only, mutated only by resolved verdicts, audited via `recordFact`.
5. **Forbidden is a KIND check, not a stake check.** Self-harm verbs and attack-your-own-faction/kin auto-refuse with **no roll offered — even for derived personas** (Tier-1 has no stake, so stake-based firewalls fail open).
6. **Depth-1 causal chains allowed.** A reaction may schedule **at most one engine-owned, cross-turn, rate-limited follow-on stimulus** (freed beast mauls the miller → next turn). Within a beat it's still single-pass.
7. **Polarity gate for pure speech.** A real closed-enum predicate re-narrates any compliance/belief assertion the engine didn't produce.
8. **Thin personas.** Reaction is a pure function; no per-NPC memory graph.
9. **Fear-compliance is capped.** Intimidation compels only **low-cost** asks; a high-cost ask under fear resolves to **flee/freeze** (`reactTo`'s threat lane), not obey.
10. **PCs are never reactors.** No stimulus admits a PC into the witness/reactor set; PC responses are always player-declared.
11. **Goals are dumb waypoints.** A `rx:goal` walks to a cell, emits one `dialogueIntent`, then **dies**. It never re-perceives, branches, or re-targets. The moment it re-evaluates the world, it's a mind.
12. **Sticky refusal has a vehicle.** A resolved refusal records `npc:<id>:refused:<ask-signature>` (scoped to scene) so re-asking the same framing is blocked; a **materially-new** offer (different economy item/quantity, or a different appeal channel — engine-legible, never LLM-judged) is a fresh stimulus. This is how haggle lives without recursion.

---

## 6. The DM Tool Surface — two thin tools, one resolver

- **`affectScene({ kind, sourceId, targetId?, locusId? })`** — broadcast lane, returns facts immediately, never suspends. `declareDisturbance` kept as a thin alias → `affectScene({kind:'threat'})` for zero eval churn.
- **`directNpc({ targetId, kind, action?, tone })`** — directed-social lane; returns facts **or** a `requestRoll` that suspends. `tone` (order/request/plea/threat/deceive) selects the skill.

Directed-material (aid/gift/trade/attack) needs **no new tool** — existing `heal`/`applyDamage`/economy ops + a standing-delta hook. In all cases the DM passes the **attempt**, never the outcome. Appeal is derived from `kind`; `say`-style free text is never accepted.

---

## 7. Phase Plan — cheapest honest proof first

**P4a — Broadcast/Summon *(crowd half only — the honest scope)*.** New `kind` + `appealTo`. Reuse oracle + `travel` + facts verbatim. No standing, no check, no suspend. **One-beat drift, not "a crowd over beats"** (that's P4f). Proves user examples #1 and #2. *This de-risks only the crowd half — the load-bearing agency/One-World risk is P4b, so run a minimal directed-command falsification alongside it (below).*

**P4b — Directed command + persona-DC gate.** `directNpc`, seeded-**immutable** standing, the DC function, `commandContinuation`, auto-obey/auto-refuse/gated, the **closed verdict enum + polarity gate**. Runs on seeded standing — the aid↑/intimidate↓ feedback loop is P4d, so this phase makes **no mutation claims**. The Tessa case: out-of-disposition → refused-in-character; passed roll → obeys-and-walks; intimidation → `feared-into-compliance` only for low-cost asks.

**P4c — Performance.** Broadcast sub-kind (draw-vs-repel on curiosity). One-beat drift.

**P4d — Standing mutation + directed-social breadth.** Greet/insult/gift/aid write the scalar; persuade/intimidate/deceive fold in (deceive vs passive Insight). Feeds back into P4b's DC.

**P4e — Environmental + Transgress.** World→perception→NPC via POI toggles (never free deltas); freed beast re-personad (beast→feral) via `applySceneDeltas` + `promoteToken`, scheduling its depth-1 follow-on (invariant 6).

**P4f — Multi-turn goals (`advanceGoals`).** Turn-top stateless reducer over flagged tokens (capped like `MAX_REACTORS`), one leg each, emits a fact, `dialogueIntent` on `done`. Dumb waypoints (invariant 11). **This is where sustained gathering actually lives.**

**P4g — Presence + Null/Wait.** Stealth/disguise as oracle pre-filter; the long silence resolves NPCs onto their `rx:goal`.

**Last:** fold `declareDisturbance` into `affectScene({kind:'threat'})` once eval parity holds.

---

## P4a FIRST SLICE — exactly what to build

**Build:**
- `packages/shared/src/persona.ts` — add `appealTo(appeal: Appeal, persona: Persona, grade: Grade): { verb:'approach'|'hold'|'recoil', approachDist:number }`. Appeal-keyed default verb; temper modifies `approachDist` and the hold/approach threshold only. Pure, no ledger.
- `apps/server/src/reactions.ts → interactions.ts` — add `resolveInteraction(stimulus)`; for `kind∈{summon,perform}` build the WitnessSet via the **existing** `gradeOf` loop, call `appealTo`, execute `approach` as `travel(mode:'auto')` toward `locus`, push `facts[]`. `resolveReactions` is retained as the `threat` branch.
- `apps/server/src/orchestrator.ts` — `affectScene({kind, sourceId, locusId?})` tool def + handler; `appeal` derived from `kind` in-handler, never accepted as input. No suspend path.
- Flag: `MYTHWEAVER_INTERACTIONS`. Off / no map / no witnesses → "no reactions," never a broken turn.

**The one demo:** a plaza of ~8 villagers (mixed persona: two curious commoners, a timid child, a keeper with `temper:steady` holding a stall). DM Lab, one turn: `affectScene({kind:'summon', sourceId:pc, locusId:well})`. **Pass:** the curious take one step toward the well, the timid drifts a shorter step, the keeper holds his post — all as engine-moved tokens with verdict facts the DM narrates.

**Why cheapest:** it reuses oracle + `travel` + facts **verbatim**; the only new code is one pure function and one non-suspending tool. It falsifies the *crowd half* of the generalization — does one appeal-split read believably across the persona taxonomy? — for the price of `appealTo`, touching neither standing, checks, suspension, nor the polarity gate.

**Go/no-go:** GO to P4b iff the persona-differentiated drift reads as believable crowd behavior in the Lab trace **and** the coherence gate passes every moved token clean (no NPC narrated where it isn't). NO-GO if the appeal→verb map already needs per-persona special-casing to look right — that means the additive model is wrong and the multiplicative table is back, and we rethink `appealTo` before spending P4b.