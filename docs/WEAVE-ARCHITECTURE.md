# The Weave Compiler — the build-ANYTHING architecture

> Origin: the "Vurel test" (2026-07-05) — the DM wrote a canal crossing in a plague-quiet city
> (shuttered windows across the water, a catatonic man in a doorway, a shrine ladling drugged
> charity to a queue) and the engine produced a generic canal-less town. Owner mandate: design
> the architecture that can build ANYTHING as assets grow — a grammar, not a phrasebook.
>
> Produced by an 8-agent research + design panel (3 web researchers: general PCG architectures,
> narrative-to-space systems, staging/tableau formalisms; 1 code-grounder; 3 independent
> architects: evolutionary / grammar-purist / exemplar-maximalist; 1 adversarial judge+synthesis
> with source-verified citations). This document is the judge's full verdict, unedited.
>
> Companion docs: SCENE-CONTRACTS.md (current contracts), VISUAL-LAYER-TODO.md (roadmap).

All load-bearing citations verified against source (including one directional error in the shared grounding — the `dominantWater` flag *prevents* town routing rather than causing it, which matters for the diagnosis). Writing the verdict.

---

# VERDICT: B's contracts, A's migration, C's flywheel

All three proposals converge on the same six-layer skeleton (requirements IR → typed networks → fabric → tableaux → state → staging, over the claims substrate, with a two-way fidelity report). That convergence is itself evidence the skeleton is right. The real disagreements are only three: **what the LLM emits** (relation graph vs. menu picks vs. dual-channel), **migration order** (design-whole vs. promote-piecewise), and **where authored feel lives** (kernel-matched data patterns vs. curated stamps). So this is not a three-way choice — it is a per-axis selection, and each proposal wins exactly one axis.

One correction to the shared code grounding before the red-team, because it sharpens the diagnosis: the claim that Vurel died because "dominantWater triggers routing to townGen" is backwards. At `scene-program.ts:571-579`, `dominantWater` (a `fill(all, water)` op) *exempts* a settlement from town routing. The actual failure fork: if the programmer emits a partial canal strip (or no water), `dominantWater=false` → `routedTown=true` → `ops.length = 0` (line 577) and only the harvested cast survives → generic town, no canal. If it *does* emit `fill(all,water)`, it escapes to the loose-op path — where towns come out as the even-grid spreadsheet the routing exists to prevent, and no canal grammar exists either. **Both prongs of the fork lose.** The disease is not the reroute; it is that the top of the pipeline is an if-ladder choosing between two whole-answer phrasebooks. That is the strongest possible evidence for the requirements-IR thesis, and none of the three proposals stated it precisely.

---

## 1. RED-TEAM

### A: Evolutionary Unifier

**Vurel by construction.** Passes if all six promotions land — but its own falsification order builds L1–L3 (rungs F0–F3) before validating L0 emission (F4). If F4 fails, A has built a grammar fed by regexes, and `BRIEF_FEATURES`/`BRIEF_TABLEAUX` harvest rows are a phrasebook with extra steps: a regex row per feature concept (`canal|millrace|moat|aqueduct…`) that must grow per scene. Harvest is the right *floor* (worst case = today's behavior — genuinely A's best structural idea); it is a wrong *primary channel*, and A hedges on which it is.

**Underspecified conflict semantics.** Dual ingestion never defines precedence. Harvest reads "plague-quiet" as abandonment 0.8; the DM emits 0.3 — who wins? Unspecified merge = undebuggable fidelity reports. This must be a contract, not a vibe.

**Relations are scattered.** A expresses spatial relations in three places (feature `relations[]`, tableau `staging` blobs, spec-level `sightlines[]`) with no unified satisfiability semantics. A fidelity report needs "dropped constraint" to be a first-class row; A's shape can't enumerate what it dropped without normalizing to B's flat constraint list anyway.

**"Independently landable" is ~15% oversold.** L2 frontage input is meaningless until L1 emits typed edges; F2's queue must hardcode the shrine slot because contracts (which carry slots) ship at F5. Tolerable — but the dependency edges exist and should be named, not marketed away.

**Story-criticality gap.** "The 4/1 shuttered/open split is the story" — then marked `soft`. Soft means droppable-with-a-log-line. A scene that delivers 5/0 windows plus a report entry has technically honored the contract and actually lost the scene. A has no tier between "hard geometry" and "droppable."

**Doctrine:** clean. LLM never touches geometry, determinism discipline explicit, no solver.

### B: Grammar Purist

**Emission risk, mis-sequenced.** B's IR is the hardest of the three to emit: features with ids + a *separate* cross-referencing constraint list + geometry classes + profile refs. Failure modes: dangling ids, wrong geom class, mutually-unsat constraint pairs (`across` + `near` on the same pair). Its mitigations are the best on offer (closed enums, archetype macros as density priors, repair round, exemplar vault of validated specs) — but it tests emission at falsification step 6, after ~2 weeks of build. The load-bearing risk must be tested for $2 before the compiler exists, not after.

**Paper-compiler step 1 is confirmation-bias theater.** The designer decomposing hand-picked scenes into the designer's own algebra always succeeds. The kill criterion ("needs a 15th relation") will never fire on 6 self-selected scenes. Fixable: adversarial selection — owner picks the scenes from real transcripts and a published module the designer hasn't read.

**The global one-way door is reckless.** Demoting the op-program to ISA *for all grammar families at once* means the compiler must reproduce G1's freeform coverage (waterfall-lakes, islands, mazes) via features+macros on day one, or expressiveness regresses. The demotion is right; it must be a **staged cutover per grammar family** (settlements first — where the phrasebook already routes anyway), with G1 behind a lab flag as baseline.

**Weakened completeness guarantee.** B relegates the brief-regex nets to "fallback synthesizer for legacy briefs." The nets are the reason a named temple can never vanish (`scene-program.ts:534-541`). If emission omits the shrine and harvest only runs on the legacy path, B delivers *below* today's floor. Harvest must be an always-on merge channel, not a fallback.

**Hidden authoring cost.** B accuses archetypes of phrasebookism while its own FeatureCatalog rows (`waterway.canal`, `crossing.footbridge`, `shrine.canalside`) each need a realization binding — profile ref, filler, contract. That's fine (it's data), but B undersells that someone writes those rows at the same per-concept rate C admits to.

**Doctrine:** the "bounded max-sat escape hatch at L1" is the top of a slippery slope. Delete it until a rung proves greedy+retry fails. Otherwise clean — and B's `constraints[]` with hard/soft + unsat-core naming is the single best contract artifact in any proposal.

### C: Exemplar Maximalist

**Fails the mandate by construction — at the relation level.** The units of novelty are authored wholes. "Two queues facing each other across the bridge," "a procession crossing the canal while a vigil watches from the far bank" — each needs either a pre-authored composite stamp (the treadmill, institutionalized as a "vault ticket" feature) or decomposition into parts with shared bindings — which is a relation graph, the exact IR C forbids. C's own cue sheet gives the game away: `"relation": "separated-by:canal"`, `"sight": "visible-from-entry"`, `"band": "far"` **is a constraint language** — impoverished, unnamed, and without satisfiability semantics. C is running B's IR through a keyhole.

**The Zipfian argument is right for a live service and wrong for this product.** MythWeaver's DM is generative prose-first; the fat tail is the point of an AI DM. Every tail miss is the Vurel experience again — deferred to a ticket, not solved. Demand-driven coverage converges on *yesterday's* scenes.

**Falsification order optimizes for the easy layers.** The canal — the framing failure — waits until F4, weeks in. Cold-start is conceded: a month of towns reading *worse* than today on the strongest current path.

**But C contributes four organs the others lack:**
1. **The miss→ticket flywheel** — fidelity-report misses auto-draft data-row tickets. Neither A nor B closes the authoring loop; C makes the report *generate the backlog*. This is the only mechanism in any proposal that makes the data treadmill self-managing.
2. **Menu-grounded emission** — show the DM the catalog index; unknown refs fail loudly. Plus composite macros (one key expands to pattern+cast+relations).
3. **Measured curation gates** (>15 min median = architecture failure) rather than aspirational budget rules.
4. **Determinism scoping** — "runtime vault immutable per session" is the only correct statement in any proposal of how byte-determinism survives growing data.

**Doctrine:** clean on LLM/geometry/determinism.

### Cross-cutting failures (all three)

- **Nobody defines harvest⊕emission merge semantics.** (Fixed in the synthesis below.)
- **Nobody scopes determinism against data growth** except C's one sentence. Byte-determinism must be per `(seed, spec, dataPackHash)`, with the hash recorded in the SceneMap.
- **"Predawn" is waved at.** The actual `Lighting` union is `day|dusk|night` (`world.ts:314` and the `LIGHTINGS` gate at `scene-program.ts:634`). Extending it touches the renderer — the **read-only visual track**. Honest v1: `predawn → dusk` + fidelity line; extending `Lighting` is a one-word owner sign-off, flagged now.
- **Nobody noticed the third embryo of L0 already in the wire contract:** `CompositionRequest.directive` (`world.ts:132-137`) — a field that exists *precisely because* EstablishScene loses spatial language. The SceneSpec is the typed generalization of a seam the codebase already grew organically. This materially de-risks the L0 bet: the pipeline has already voted for it once.
- **Nobody tests the interaction bets.** A canal through-fabric intersects townGen's plaza selection (`archetypes.ts:109-136`), park placement, and wall ring. The canal rung must gate on "canal + plaza + wall coexist across 50 seeds, coherence sweep ≤ current 4% dirty."

---

## 2. SCORES

| Axis | A: Evolutionary | B: Grammar Purist | C: Exemplar Maximalist |
|---|---|---|---|
| Generative span ("anything" as data grows) | 8 — full algebra, weaker relation semantics | **9** — multiplicative axes, formal constraints | 5 — capped at authored composites; novel relations wait on stamps |
| Doctrine fit (LLM out of geometry, determinism, $0 runtime) | **9** | 8 — max-sat hatch docked half a point | 8 — clean, but cold-start regresses the strong path |
| Incremental landability | **9** — byte-diff promotions on live code | 6 — contract-whole design, global cutover, emission tested late | 8 — cheap early rungs, but the framing failure lands last |
| Authored feel | 6 | 6 | **9** — every set-piece curated; misses become tickets |
| Asset-future fit (new art widens grammar, zero code) | 8 | 8 | **9** — affordance-binding as the engine |
| LLM-emission reliability of its IR | 8 — harvest floor saves it | 6 — hardest IR, tested latest | **9** — menu picks |
| Overall risk | **Medium-low** — worst case is today's behavior | Medium-high — big-bang contracts + emission bet | Medium — low build risk, permanent expressiveness ceiling |

**Call:** B wins the contract layer, A wins the migration strategy, C wins the authoring economy. None is safe to run alone: A alone drifts into a regex phrasebook, B alone bets the quarter on an untested IR, C alone rebuilds the phrasebook in JSON with better hygiene.

---

## 3. THE SYNTHESIS: the Weave compiler

One spine — **B's contract stack**, landed as **A's six promotions** of living code, powered by **C's authoring flywheel**. Names below are final; owners are real files.

```
DM prose ──► setScene (unchanged) + optional spec field (additive)
   │
   ├─ EMISSION: DM/Director emits SceneSpec (closed enums, catalog-grounded, macro sugar)
   ├─ HARVEST:  brief nets extended (BRIEF_CONDITIONS/…) — ALWAYS runs
   ▼
L0 SceneSpec ......... requirements IR ......... packages/shared/src/scene-spec.ts (NEW)
   │   merge = emission ⊕ harvest (semantics below); validate schema + vocab + hard-presat
   ▼
L1 Loom .............. typed seam networks ..... packages/scene/src/networks.ts (NEW, extracted
   │   over the region partition                 from archetypes.ts:76-107 + citymesh seams)
   │   ENTRY POSE IS AN L1 SEED (frame.entry constrains routing before geometry exists)
   ▼
L2 Fabric ............ region fillers .......... archetypes.ts / city-realizer.ts / cartographer.ts
   │   behind ONE FabricFiller interface; consumes frontages + conditions + default-occupancy
   ▼
L3 Tableaux .......... cast + placement ........ packages/scene/src/tableaux.ts (NEW; grown from
   │   casting (CityContents roster) SPLIT       vignette()/stations; patterns are data rows)
   │   from placement (claims pattern-match)
   ▼
L4 State ............. contracts + conditions .. packages/scene/src/asset-contracts.ts (NEW) +
   │   cosmetic tier = skin; structural tier     content/grammar/{profiles,patterns,contracts}/*.json
   │   REWRITES claims (ruined bridge = no crossing)
   ▼
L5 Staging ........... entry-frame residuals ... place() extension in primitives.ts
   │   distanceBand × sideOf × los × separatedBy (los = existing depth-cast)
   ▼
SceneMap + FidelityReport ──► DM digest ──► re-narration + miss→ticket queue
```

**The substrate:** the existing `Canvas` claims grid (`primitives.ts:36-101`), extended with `CLAIM_BARRIER` and `CLAIM_OSPACE` bits plus typed-edge annotations. Every stage annotates; no stage hands the next an opaque blob. The coherence probes (`coherence-check.ts`) stay **claims-blind by design** — the fence and the net never share eyes (that discipline, already written into the file header, is why the fidelity report can be trusted).

### Binding decisions (the ones the proposals fought over)

1. **One DM-facing IR: the SceneSpec, B-shaped.** Typed `features[]` + one flat `constraints[]` with a closed relation enum and hard/soft semantics. C's cue-sheet is rejected as the IR but absorbed as **macro sugar**: `tableaux` and `features` may reference named composites (`"macro": "shrine_ladle_service"`) that expand *at validation time* into patterns + roles + constraints in the same IR. The exemplar vault stores validated **specs**, not prose (Technique B applied to specs — both A and B independently proposed this; adopted).
2. **Three-tier weights, not two.** `hard` (fails the stage, forces re-plan or declared degradation) / `story` (satisfiability-soft, but degradation MUST surface in the DM digest with a re-narration instruction — this is the 4/1 window fix) / `soft` (maximized, dropped silently into the report). This tier is my addition; no proposal had it, and the Vurel windows demand it.
3. **Merge semantics (harvest ⊕ emission), now specified:** harvest always runs. Union keyed by `(kind, tag)`; on field conflict **emission wins**; every harvest-injected row is tagged `source:'net'` in both the spec and the fidelity report. Missing/invalid emission degrades to pure harvest = today's floor, byte-for-byte. The completeness-net guarantee (a named temple can never vanish) survives intact.
4. **Staged cutover, not a one-way door.** Settlements move to the Weave first (the reroute at `scene-program.ts:575-579` is already discarding LLM output there — replacing it can only add information). Dungeon/cave/wild families follow one at a time; G1 stays behind a lab flag as A/B baseline until each family's Weave path beats it in the lab.
5. **Determinism contract:** scene bytes are a pure function of `(seed, resolved SceneSpec, dataPackHash)`. Data packs (profiles, patterns, contracts, macros) are immutable per session; the hash is recorded in SceneMap meta. Claims stay rng-free (`primitives.ts:80` contract).
6. **The flywheel:** every fidelity line of class `unrepresented-concept` or `missing-variant` auto-drafts a ticket (LLM-drafted data row, offline, human-curated ≤15 min, schema-validated in CI). The report is not a log; it is the narrator's input **and the backlog generator**.
7. **No solver.** Per-stage monotonic checks, graph-level reachability at L1, Brogue-style local pattern-matching at L3, local retry, failures stay local (a failed tableau never dirties the map). B's max-sat hatch is deleted.

### The Vurel scene in the FINAL IR

```jsonc
{
  "specVersion": 1,
  "seed": "vurel-canal-predawn",
  "brief": "Canal crossing near the heart of Vurel, plague-quiet, predawn. …",   // survives to narrator
  "frame": { "grammar": "settlement", "entry": { "edge": "south", "pose": "arriving" } },

  "conditions": [
    { "profile": "abandonment", "value": 0.8, "source": "emitted" },
    { "profile": "predawn" },                       // v1: lighting→dusk + fidelity line (renderer untouched)
    { "profile": "haze", "value": 0.4 }
  ],

  "features": [
    { "id": "canal1",  "kind": "waterway.canal",   "geom": "network", "profile": "water.canal" },
    { "id": "row1",    "kind": "building.house",   "geom": "region",  "count": 3 },
    { "id": "winShut", "kind": "window", "geom": "point", "count": 4, "states": { "shutter": "closed" } },
    { "id": "winOpen", "kind": "window", "geom": "point", "count": 1, "states": { "shutter": "open" } },
    { "id": "shrine1", "kind": "shrine", "geom": "point", "states": { "upkeep": "mossy" } },
    { "id": "door1",   "kind": "doorway", "geom": "point" }
  ],

  "constraints": [
    { "c": "through-fabric",  "f": "canal1",                          "w": "hard"  },
    { "c": "crossable",       "f": "canal1", "at": "circulation",     "w": "hard"  },  // bridge DERIVES here
    { "c": "across",          "a": "row1",   "b": "PARTY", "via": "canal1", "w": "hard" },
    { "c": "in",              "a": "winShut", "region": "row1",       "w": "story" },
    { "c": "in",              "a": "winOpen", "region": "row1",       "w": "story" },  // the 4/1 split = story tier
    { "c": "facing",          "a": "winShut", "b": "PARTY",           "w": "soft"  },
    { "c": "along",           "a": "shrine1", "b": "canal1",          "w": "story" },
    { "c": "near",            "a": "shrine1", "b": "PARTY", "band": [12, 20], "w": "soft" },
    { "c": "visible-from",    "a": "shrine1", "b": "PARTY",           "w": "soft"  },
    { "c": "unreachable-from","a": "row1",    "b": "PARTY",           "w": "soft"  },
    { "c": "side",            "a": "door1",   "of": "PARTY", "dir": "right", "paces": 3, "w": "story" }
  ],

  "tableaux": [
    { "id": "tQueue", "macro": "shrine_ladle_service",     // composite: expands to VIGIL@service-slot + QUEUE
      "focus": "shrine1",
      "roles": { "officiant": { "cast": "npc:monk", "prop": "pot" },
                 "line": { "cast": "villager", "count": 6, "state": "shuffling" } } },
    { "id": "tDoor", "pattern": "doorway-figure", "focus": "door1",
      "roles": { "figure": { "cast": "npc:villager", "name": "a hollow-eyed man", "state": "catatonic" } } }
  ],

  "narrationOnly": [ "the temple bell does not ring", "pale sweet smoke on the air" ]
}
```

Closed relation enum, v1 (**11 — additions require a kernel RFC**): `through-fabric, crossable, across, along, near, side, visible-from, unreachable-from, facing, in, at-edge-of`. No coordinates, no ops, no sprite tags anywhere in the spec.

**How it compiles:** L1 routes `canal1` as a water-profile seam across the entry vector (the `across…hard` constraint constrains block selection before rasterization); the bridge is *derived* where the barrier claim meets the circulation claim — exactly how door aprons already derive (`primitives.ts:381-386`). L2 fills the far block with `frontage: canal` (moorings, not front yards); the house filler emits window point-slots on the facade. L3 casts from the CityContents roster (`city-realizer.ts:150` — the monk and villagers are guaranteed present by the nets) and pattern-matches the queue column against free APPROACH-clear bank tiles ending at the shrine's contract-advertised `service` slot. L4 resolves `shutter` variants (missing art → degrade ladder → fidelity line "narrate the shutters"), applies abandonment by **suppressing declared default-occupancy** (townGen STAGE 6 at `archetypes.ts:238-243` and the city-realizer's street folk at `city-realizer.ts:475` are the two suppression sites that already exist) and biasing `upkeep→mossy`. L5 filters candidate doors by `sideOf(right) × distanceBand(2,4) × los(entry)` — the LOS predicate is the existing privacy depth-cast. The bell and the smoke go to the report verbatim, and the DM keeps them alive in prose.

### Asset-contract schema (final)

One file per **concept**, beside the art, schema-validated in CI. Generators write concepts; art fulfills contracts; a PNG without a contract is invisible to the grammar; a contract without art degrades loudly.

```jsonc
// content/grammar/contracts/shrine.json
{
  "concept": "shrine",
  "class": "fixture",                          // opening | surface | fixture | figure | effect | network-material
  "geom": "point",                             // point | region | edge-profile
  "footprint": { "w": 2, "h": 2 },

  "variants": {
    "axes": { "upkeep": ["kept", "mossy", "ruined"] },
    "default": { "upkeep": "kept" },
    "degrade": { "upkeep.mossy": ["upkeep.kept", "narrate"] },   // ordered; every step → fidelity line
    "structural": {                                              // tier 2: variants that REWRITE the substrate
      "upkeep.ruined": { "removesClaim": "APPROACH" }            // (a ruined bridge would remove CIRCULATION)
    }
  },

  "affordances": ["queue-anchor", "vigil-anchor", "audience-focus"],   // L3 binds by affordance, not by name:
  "slots": [                                                           // new art with these lines is stageable
    { "id": "service",  "offset": "front", "role": "officiant", "claim": "APPROACH" },
    { "id": "approach", "kind": "run", "facing": "front", "minLen": 3 }
  ],

  "fulfillment": {
    "sprites": { "upkeep.kept": "altar" },     // variant-key → asset tag; missing keys walk the degrade ladder
    "fallbackConcept": "altar"                 // last rung before "omit + report"
  }
}
```

Backfill is mechanical: today's ~200 tags become `{concept: tag, variants: {}, class: inferred}` on day one. The stations' hand-coded keep-clear approaches (`cartographer.ts:532, 589, 615`) migrate verbatim into `slots`/`claims` — they are the proto-contracts.

### Keep / extend / replace (verified against source)

**KEEP (untouched load-bearers):**
- `Canvas` + claims grid + `stampClaim`/`claimed` (`primitives.ts:36-101`) — the substrate; gains `CLAIM_BARRIER`, `CLAIM_OSPACE` bits only.
- Coherence probes (`coherence-check.ts`) — stay claims-blind; every rung gates on the sweep.
- `CityContents` + completeness nets (`city-realizer.ts:150`, `scene-program.ts:464-543`) — promoted to the permanent harvest channel + L3 casting pool.
- `citymesh.ts`/`citybsp.ts`/`city-realizer.ts` M0-M6 — the region partition and the future Loom host (roadmap task #10 "Water & terrain features" becomes the canal rung).
- Depth-cast, `resolveAnchor`/`snapToFree`, `furnishRoom`, `BUILDING_TEMPLATES` (`cartographer.ts:46`), blue-noise/clump scatter, `finalize()` (`primitives.ts:1171`), determinism discipline.

**EXTEND (the promotions):**
- townGen STAGE 1 street carving (`archetypes.ts:76-107`) → **extract `routeSeam(profile)` into `networks.ts`**; street = MaterialProfile #1, byte-diff enforced; `water.canal` = profile #2; `routing: 'field'` enum reserved, unimplemented.
- `scatter()` arrangement machinery + `place()` (`primitives.ts`) → placer atoms (`column|arc|ring|vis-a-vis|scatter`) + the four staging predicates.
- `normalizeProgram` (`scene-program.ts:555-640`) → the SceneSpec assembler: nets extended with `BRIEF_CONDITIONS`; emission merged per the ⊕ rules.
- `themes.ts` → ConditionProfiles (a theme is the degenerate profile at intensity 0 — C's framing, adopted).
- `MapObject.state` (`world.ts:282`) → written by L4 under contract governance (same field, now schema'd).
- `CoherenceReport` → joined by `FidelityReport` (`packages/scene/src/fidelity.ts`, NEW): `{honored, degraded[{req, delivered, why}], dropped, narrationOnly, tickets}` — flows into the scene digest the DM already reads.
- `EstablishScene`/`setScene` → additive optional `spec` field (`world.ts:113-119`; the wire schema is never broken; `CompositionRequest.directive` at `world.ts:137` is the vestigial ancestor and is eventually absorbed).

**REPLACE (deleted, eventually):**
- The routing if-ladder and both its prongs (`scene-program.ts:571-579`): `ops.length = 0` dies; settlement briefs compile specs. Archetypes become **spec macros** (data bundles of default features/constraints a sparse spec inherits — B's best organ, keeps sparse-emission scenes dense).
- `VIGNETTES` record + `vignette()` handlers (`primitives.ts:1140-1159`): the six existing vignettes are rewritten as the first six pattern data rows (day-one migration proves the schema on known-good content).
- G1-as-surface-language for settlements first, per the staged cutover; retained behind a lab flag as baseline elsewhere.

### Falsification ladder (cheapest information first; every rung Scene-Lab-visible; each with a kill criterion)

| Rung | Cost | Test | Kills |
|---|---|---|---|
| **R0** | 0.5 day, $0 | **Adversarial paper decomposition** — owner (not the designer) picks 8 scenes from real DM Lab transcripts + 2 from a published module; hand-write specs. | The IR, if any scene needs a 12th relation or a 7th statement kind more than once. |
| **R1** | 2-3 days | **Seam extraction + byte-diff**: `routeSeam` out of townGen, street = profile #1, 50 seeds byte-identical; then flip `water.canal` behind a lab toggle; bridges derive at circulation crossings; canal + plaza + wall coexist; sweep ≤ 4% dirty. | L1, if profiles need town-specific special-casing everywhere (the Watabou risk, priced at days). |
| **R2** | 1 day, ~$2 (parallel with R1) | **Emission trial, validator only**: schema + 6 exemplars, 20 held-out briefs; measure schema validity, dangling refs, unsat hard-pairs, harvest agreement. | L0-as-primary, if validity < 90% after one repair round → shrink the surface toward macros/menu (C posture) and re-run before building anything on it. |
| **R3** | 2 days | **QUEUE as data**: pattern row + column atom + casting from roster at an existing plaza shrine; a failed tableau leaves the map clean (Merrell property, asserted in test). | L3, if placement needs per-pattern geometry code. |
| **R4** | 1-2 days | **Staging predicates** on `place()` + entry-seeded block orientation; measure post-hoc vs. seeded satisfaction of `across` on 20 seeds. | L5b, and confirms/refutes the L5a-upstream claim with data. |
| **R5** | 2 days | **Abandonment knob**: `BRIEF_CONDITIONS` + `plague_quiet`; default-occupancy declared on 3 venue types; lab A/B same seed at 0.0 vs 0.8. | L4-profiles, if suppression reads as sparse rather than abandoned. |
| **R6** | 2 days | **Contract + degradation loop**: window contract, one missing variant; fidelity line → DM digest → re-narration in a live DM Lab turn. | L4 + the two-way report. |
| **R7** | ~1 week | **Vurel end-to-end** — all hard constraints honored, story-tier degradations narrated; joins `npm run eval` as a standing acceptance test. | The composition. |
| **R8** | standing | **Treadmill test**: novel pattern (PROCESSION), novel profile (aqueduct), novel macro — each pure JSON, ≤30 min authoring, ≤15 min curation, working in the lab; re-run after every vault batch. | The whole thesis, if the grammar has quietly become a phrasebook again. |

Total falsification budget before full commitment: ~2.5 weeks, with R0-R2 (the two existential bets: IR shape, water-on-mesh) resolved inside the first four days for under $5.

### NOT building

- No global constraint solver — no ASP, no MILP, no whole-scene WFC, and **no max-sat escape hatch** (B's is deleted; if greedy+retry ever provably fails, that is a new decision, taken then).
- No elevation fields or field-routed rivers in v1 (`routing: 'field'` reserved in the profile schema; watabou's lesson honored by keeping the slot, not the implementation).
- No NPC behavior simulation, schedules, needs, or history sim — tableaux are frozen staging; the DM's prose is the history.
- No renderer/camera/3D work; `predawn` maps to `dusk` + fidelity line until the owner signs off on touching the visual track's `Lighting` union.
- No diffusion/ML anywhere in layout; art generation stays a separate concern.
- No new whole-scene archetypes, ever — the top-level catalogue is closed for burial.
- No runtime LLM authoring of data rows — drafting offline, curation human, packs immutable per session.
- No speculative libraries — ship exactly Vurel's needs (2 profiles, 3 patterns, ~3 contracts, 1 macro); R8 proves the authoring path and demand fills the rest.
- No second long-term surface language — staged cutover per grammar family, G1 behind a lab flag as baseline until each family's Weave path beats it.

### The single first concrete step

Extract the street carver into the network engine, with a byte-diff gate:

```
packages/scene/src/networks.ts
  export interface MaterialProfile {
    id: string;                                       // 'street' | 'water.canal' | 'wall' | …
    bed: { tag: string; walkable: boolean; width: [number, number] };
    banks?: { tag: string; width: number };
    crossing?: { kind: string; spacingMin: number };  // derived where CLAIM_BARRIER × CLAIM_CIRCULATION
    claimBit: number;                                 // CLAIM_CIRCULATION | CLAIM_BARRIER (new)
    routing: 'fabric';                                // 'field' reserved, rejected by schema in v1
  }
  export function routeSeam(cv: Canvas, region: Rect, profile: MaterialProfile, opts: …): SeamResult
```

Lift STAGE 1 of `townGen` (`archetypes.ts:76-107`) into it; `street` is profile #1; CI proves **50 seeds byte-identical** before and after; then flip a `water.canal` profile behind a Scene Lab toggle and look at the first canal town in `/lab`. Two to three days, zero regret (it is a pure refactor of the strongest code path even if every other layer dies), it resolves the deepest geometry bet in the whole design — and it makes the sentence "no canal representation exists" false. Run R0 and R2 in parallel the same week; they cost half a day and two dollars.

**One sentence:** adopt B's SceneSpec-and-constraints as the single DM-facing contract, land it as A's byte-diff-gated promotions of townGen, vignettes, nets, themes, and anchors over the existing claims substrate, and run C's miss→ticket flywheel so every scene the grammar cannot yet say becomes next week's fifteen-minute data row — with the Vurel scene as the standing acceptance test that none of it is a phrasebook.
