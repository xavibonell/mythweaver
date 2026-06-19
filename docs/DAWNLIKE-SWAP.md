# DawnLike base swap — plan & checklist (`feat/dawnlike-assets`)

Swap the interim Kenney "Tiny" trio for **DawnLike — 16×16 Universal Rogue-like tileset v1.81**
(DragonDePlatino & DawnBringer). Flat top-down, DawnBringer-16 palette, the closest free stylistic
neighbor to our flat look — and a clear aesthetic upgrade.

- Source: https://opengameart.org/content/dawnlike-16x16-universal-rogue-like-tileset-v181
- **License: CC-BY 4.0** (not CC0). Obligations: (1) an attribution line ("DawnLike by DragonDePlatino
  & DawnBringer, CC-BY 4.0"); (2) the author's quirk — keep the hidden `DragonDePlatino` dragon sprite
  in shipped files. Fine for a PoC; tracked via the new `license`/`attribution` fields on each record.

## Why swap-first, then autotiling (not the reverse)
Autotiling needs edge/corner/transition tiles to even be built or tested — our Kenney Tiny set has one
flat tile per terrain, so there's nothing to drive it. DawnLike *ships* transition + wall auto-tile
variants. So: **(1) swap (a `library.json` re-point — immediate visual win, hard seams like today but
nicer tiles), then (2) build 8-neighbour autotiling against DawnLike's real edge tiles.** DawnLike is
flat top-down, so the oblique-perspective problem that gates the Kenney Roguelike pack does NOT apply.

## ⚠ Coverage caveat — DawnLike is DUNGEON/WILD-centric
It's a roguelike set: excellent terrain, dungeon dressing, and a huge CREATURE roster; **thin on
SETTLEMENT/FARM** (houses, market stalls, fountains, cows/sheep/goats/horses). Plan per group below.
Eyeball coverage in `/lab` before committing the full swap; settlement/farm tags may stay on our
`gen` compositor or fall back to the placeholder.

## The swap is a data op
Per tag: re-point `from` to a DawnLike crop (`{pack:"dawnlike", crop:"<sheet>.png", rect:[x,y,16,16]}`)
or copy from a pre-split atlas fork (e.g. tommyettinger/DawnLikeAtlas → `copy:"…/tile_NNNN.png"`).
Add `license`/`attribution`. Then `npm run assets:extract`. Tags/contracts are unchanged — proven by
the Kenney swap. Keep the old Kenney `from` in git so revert is one diff.
**Cohesion rule: it's a FULL swap (terrain + props + characters). Do NOT mix DawnLike terrain with
Kenney characters** — that reintroduces palette drift. DawnBringer-16 is cooler/more saturated than
Kenney's pastels; everything-DawnLike is internally consistent.

## The 59 tags to re-point (→ likely DawnLike source sheet)
DawnLike ships category sheets (Objects/: Floor, Wall, Tile, Door, Tree, Decor0/1, Chest, Ground0/1,
Fence, Pit…; Characters/: Player0/1, Humanoid0/1, Undead0/1, Demon0/1, Rodent0/1, Reptile0/1,
Aquatic0/1, Avian0/1, Dog0/1, Cat0/1, Misc0/1 — many with 2 animation frames). Exact rects TBD once
the pack is in `raw-packs/dawnlike/`.

### terrain (7)
- grass, dirt, sand, stone → Ground/Floor sheets (sand = a tan ground variant)
- water, water_deep → Ground water tiles (animated; pick the 2 frames or one)
- wall → Wall sheet (also gives us the autotile variants for step 2)

### props (25)
- tree, tree_pine, tree_autumn → Tree sheet · bush, mushroom → Decor · fence → Fence
- chest → Chest · barrel, crate, table → Decor · brazier → Decor (torch/flame)
- gravestone, sarcophagus, altar, stairs, signpost → Tile/Decor (statues/tombs/stairs are dungeon staples → good coverage)
- **SETTLEMENT/uncertain:** market_stall, house_red/blue/grey/wood/tall, fountain → likely NOT in DawnLike →
  keep our `gen` house/fountain compositor (they already draw in a palette we control; may need a palette tweak), or composite from DawnLike walls/roofs.
- boat → not in DawnLike → keep our `gen:boat` (recolor to DawnBringer if needed) · placeholder → keep (internal)

### characters (27)
- knight, rogue, ranger, dwarf, villager, villager_woman, wizard → Player/Humanoid sheets
- orc, goblin → Humanoid/Demon · skeleton, zombie → Undead · slime → Misc/Slime · spider → Misc
- dragon → Reptile (drake) · crab → Aquatic · chicken, duck → Avian · wolf, dog → Dog · cat → Cat
- frog → Aquatic/Misc · rabbit, deer, rodent → Rodent/Misc
- **FARM/uncertain:** cow, sheep, goat, horse → DawnLike is light on livestock → may fall back to a
  nearest creature or the placeholder; flag in `/lab`.

## Steps
1. [ ] Drop DawnLike into `raw-packs/dawnlike/` (gitignored; user-provided).
2. [ ] Map each tag's `from` to a DawnLike crop/copy (this doc = the checklist) + set `license`/`attribution`.
3. [ ] `npm run assets:extract`; eyeball every group in `/lab`; decide settlement/farm fallbacks.
4. [ ] `npm test` + `npm run scene:eval` (re-pin baseline — palette/coverage shift will move judge scores).
5. [ ] THEN (separate PR): 8-neighbour autotiling (Phase C1) against DawnLike's edge tiles.
