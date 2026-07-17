/**
 * THEMES — one coherent material palette per scene (the "one tileset per level" rule that kills
 * floor noise). A scene picks ONE theme; every open-ground op (fill/plaza/path/maze/rooms floor) and
 * every archetype generator draws its ground/path/plaza/wall material from it, so materials never
 * clash cell-to-cell. Hazards (water/lava/sand) + per-building materials are the only terrain NOT
 * themed. Extracted to its own module so BOTH the program interpreter (scene-program.ts) AND the
 * archetype generators (archetypes.ts) can share it without an import cycle.
 */

import type { LayoutGrammar } from '@mythweaver/shared';

/** Wall MATERIAL families. wood/stone are the DawnLike originals; sandstone…ice are forged 9-suffix
 *  families; acid…snow are the promoted DawnLike-atlas wall families (autotile remapped from DawnLike's
 *  connectivity naming to our suffix scheme). All are wall_<mat> + _t/_b/_l/_r/_tl/_tr/_bl/_br and
 *  autotile through bakeWoodWalls. */
export type WallMat =
  | 'wood' | 'stone' | 'sandstone' | 'moss' | 'obsidian' | 'bone' | 'ice'
  | 'acid' | 'blue' | 'brick' | 'deep' | 'fort' | 'heat' | 'infernal' | 'mine' | 'orange' | 'rock' | 'snow';

/** Wall BASE TAG for a material: wood→wall_wood, stone→wall, forged families → wall_<mat>. */
export const wallBaseOf = (mat: WallMat): string => (mat === 'wood' ? 'wall_wood' : mat === 'stone' ? 'wall' : `wall_${mat}`);

export interface Theme {
  ground: string;
  path: string;
  plaza: string;
  wallMat: WallMat;
}

export const THEMES: Record<string, Theme> = {
  village: { ground: 'grass', path: 'dirt', plaza: 'road', wallMat: 'wood' }, // plaza = the unified cobble (road)
  forest: { ground: 'grass', path: 'dirt', plaza: 'grass', wallMat: 'wood' },
  swamp: { ground: 'grass', path: 'mud', plaza: 'mud', wallMat: 'wood' }, // bog grass + trodden mud
  jungle: { ground: 'grass', path: 'mud', plaza: 'moss_floor', wallMat: 'moss' }, // overgrown ruin palette
  dungeon: { ground: 'stone', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
  crypt: { ground: 'stone_brick', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
  necropolis: { ground: 'marble_dark', path: 'stone', plaza: 'marble_dark', wallMat: 'bone' }, // the bone city
  temple: { ground: 'marble', path: 'marble', plaza: 'marble_dark', wallMat: 'stone' }, // veined-marble sanctum
  cave: { ground: 'dirt', path: 'dirt', plaza: 'road', wallMat: 'rock' }, // natural rough-rock cavern walls
  desert: { ground: 'sand', path: 'dirt', plaza: 'sandstone_floor', wallMat: 'sandstone' },
  lava: { ground: 'ash', path: 'ash', plaza: 'obsidian_floor', wallMat: 'obsidian' }, // cinders + volcanic glass
  arctic: { ground: 'snow', path: 'dirt', plaza: 'snow', wallMat: 'ice' }, // trodden tracks through snowfield
  blight: { ground: 'blight', path: 'ash', plaza: 'blight', wallMat: 'stone' }, // cursed/corrupted ground
  // DawnLike-atlas wall families (Step 3d) get their own themed scenes:
  infernal: { ground: 'ash', path: 'ash', plaza: 'obsidian_floor', wallMat: 'infernal' }, // a hell dimension
  fortress: { ground: 'stone', path: 'stone', plaza: 'flagstone', wallMat: 'fort' }, // heavy fitted battlements
  sewer: { ground: 'stone', path: 'stone', plaza: 'flagstone', wallMat: 'acid' }, // grimy undercity drains
  underdark: { ground: 'stone_brick', path: 'stone', plaza: 'marble_dark', wallMat: 'deep' }, // the deep roads
  mine: { ground: 'dirt', path: 'dirt', plaza: 'stone', wallMat: 'mine' }, // rough-hewn shafts
};
export const THEME_NAMES = Object.keys(THEMES);

const THEME_ALIASES: [RegExp, string][] = [
  [/necropolis|ossuary|barrow|boneyard/, 'necropolis'], // before crypt — its regex also matches 'necro'
  [/crypt|tomb|catacomb|grave|undead|necro/, 'crypt'],
  [/blight|curse|corrupt|tainted|defiled|wither/, 'blight'],
  [/infernal|hellish|abyssal|brimstone|diabolic|nine hells|the hells/, 'infernal'], // before lava — hell walls
  [/lava|volcano|magma|molten|ashen|cinder/, 'lava'],
  [/sewer|drain|cistern|aqueduct|undercity|effluent/, 'sewer'],
  [/underdark|\bdrow\b|duergar|deep roads?|underroad|the underdark/, 'underdark'], // NOT bare "the deep" — it caught "the deep wood/river"
  [/\bmine\b|mineshaft|colliery|excavation|ore vein/, 'mine'], // before cave — rough shafts
  [/fortress|bastion|rampart|stronghold|battlement|garrison/, 'fortress'], // before dungeon
  [/arctic|tundra|glacier|frozen|\bsnow|blizzard|permafrost|\bice\b/, 'arctic'],
  [/cave|cavern|grotto|warren|tunnel/, 'cave'],
  [/desert|dune|\bsand|waste|oasis/, 'desert'],
  [/jungle|rainforest|overgrown|liana/, 'jungle'],
  [/swamp|\bfen\b|marsh|bog|mire|moor/, 'swamp'],
  [/temple|shrine|cathedral|church|chapel|sanctum|monaster|abbey/, 'temple'],
  [/dungeon|vault|prison|jail|fort|castle|keep|citadel|stone/, 'dungeon'],
  [/forest|wood|grove|glade|wild|thicket/, 'forest'],
  [/village|town|city|market|hamlet|settlement|square|plaza/, 'village'],
];

// Themes whose GROUND is an enclosed-space floor (cave-dirt / dungeon-stone / crypt / lava). On an
// OUTDOOR settlement these must never win from a brief keyword — a "mining town" or a "temple town" is a
// grass settlement with a mine/temple FEATURE, not a scene floored in cave-dirt. (This is why a coastal
// mining village rendered on monotone orange dirt: "mine" → cave theme → dirt ground everywhere.)
const INTERIOR_THEMES = new Set(['crypt', 'lava', 'cave', 'dungeon', 'temple', 'necropolis', 'infernal', 'fortress', 'sewer', 'underdark', 'mine']);

/** Resolve a theme name (or infer from the brief) to a Theme key. */
export function themeNameFor(name: unknown, brief: string, grammar: LayoutGrammar): string {
  const lc = `${typeof name === 'string' ? name : ''} ${brief}`.toLowerCase();
  // A SETTLEMENT is grass with mine/temple/etc. as FEATURES — so an interior-floor theme must never win
  // there from a feature keyword. (A bare "crypt"/"cave" brief is NOT a settlement, so it still resolves
  // to its interior theme.) This is what kept a coastal mining village off monotone cave-dirt.
  const settlement = grammar === 'town-square' || /\b(town|village|city|hamlet|township|settlement|market town|port|harbou?r|fishing village|seaside|outpost)\b/.test(lc);
  // An OPEN-OUTDOOR (wild) scene is never floored in an INTERIOR palette (dungeon/crypt/cave stone) —
  // a forest with a "standing stone", a "mossy stone" bank, or a DM narrating "ancient stone" must not
  // turn the whole wood to brick. Same guard settlements already have (a mining TOWN ≠ a cave floor).
  const skip = (t: string) => (settlement || grammar === 'open-outdoor') && INTERIOR_THEMES.has(t);
  if (typeof name === 'string' && THEMES[name.toLowerCase()] && !skip(name.toLowerCase())) return name.toLowerCase();
  for (const [re, t] of THEME_ALIASES) if (re.test(lc) && !skip(t)) return t;
  return grammar === 'enclosed-interior' ? 'dungeon' : 'village';
}
