/**
 * THEMES — one coherent material palette per scene (the "one tileset per level" rule that kills
 * floor noise). A scene picks ONE theme; every open-ground op (fill/plaza/path/maze/rooms floor) and
 * every archetype generator draws its ground/path/plaza/wall material from it, so materials never
 * clash cell-to-cell. Hazards (water/lava/sand) + per-building materials are the only terrain NOT
 * themed. Extracted to its own module so BOTH the program interpreter (scene-program.ts) AND the
 * archetype generators (archetypes.ts) can share it without an import cycle.
 */

import type { LayoutGrammar } from '@mythweaver/shared';

/** Wall MATERIAL families. wood/stone are the DawnLike originals; the rest are forged 9-suffix
 *  families (wall_<mat> + _t/_b/_l/_r/_tl/_tr/_bl/_br) — bakeWoodWalls autotiles all of them. */
export type WallMat = 'wood' | 'stone' | 'sandstone' | 'moss' | 'obsidian' | 'bone' | 'ice';

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
  cave: { ground: 'dirt', path: 'dirt', plaza: 'road', wallMat: 'stone' }, // outdoor-ish square → unified cobble
  desert: { ground: 'sand', path: 'dirt', plaza: 'sandstone_floor', wallMat: 'sandstone' },
  lava: { ground: 'ash', path: 'ash', plaza: 'obsidian_floor', wallMat: 'obsidian' }, // cinders + volcanic glass
  arctic: { ground: 'snow', path: 'dirt', plaza: 'snow', wallMat: 'ice' }, // trodden tracks through snowfield
  blight: { ground: 'blight', path: 'ash', plaza: 'blight', wallMat: 'stone' }, // cursed/corrupted ground
};
export const THEME_NAMES = Object.keys(THEMES);

const THEME_ALIASES: [RegExp, string][] = [
  [/necropolis|ossuary|barrow|boneyard/, 'necropolis'], // before crypt — its regex also matches 'necro'
  [/crypt|tomb|catacomb|grave|undead|necro/, 'crypt'],
  [/blight|curse|corrupt|tainted|defiled|wither/, 'blight'],
  [/lava|volcano|magma|infernal|molten|brimstone|ashen|cinder/, 'lava'],
  [/arctic|tundra|glacier|frozen|\bsnow|blizzard|permafrost|\bice\b/, 'arctic'],
  [/cave|cavern|grotto|warren|\bmine\b|tunnel/, 'cave'],
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
const INTERIOR_THEMES = new Set(['crypt', 'lava', 'cave', 'dungeon', 'temple', 'necropolis']);

/** Resolve a theme name (or infer from the brief) to a Theme key. */
export function themeNameFor(name: unknown, brief: string, grammar: LayoutGrammar): string {
  const lc = `${typeof name === 'string' ? name : ''} ${brief}`.toLowerCase();
  // A SETTLEMENT is grass with mine/temple/etc. as FEATURES — so an interior-floor theme must never win
  // there from a feature keyword. (A bare "crypt"/"cave" brief is NOT a settlement, so it still resolves
  // to its interior theme.) This is what kept a coastal mining village off monotone cave-dirt.
  const settlement = grammar === 'town-square' || /\b(town|village|city|hamlet|township|settlement|market town|port|harbou?r|fishing village|seaside|outpost)\b/.test(lc);
  const skip = (t: string) => settlement && INTERIOR_THEMES.has(t);
  if (typeof name === 'string' && THEMES[name.toLowerCase()] && !skip(name.toLowerCase())) return name.toLowerCase();
  for (const [re, t] of THEME_ALIASES) if (re.test(lc) && !skip(t)) return t;
  return grammar === 'enclosed-interior' ? 'dungeon' : 'village';
}
