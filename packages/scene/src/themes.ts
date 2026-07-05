/**
 * THEMES — one coherent material palette per scene (the "one tileset per level" rule that kills
 * floor noise). A scene picks ONE theme; every open-ground op (fill/plaza/path/maze/rooms floor) and
 * every archetype generator draws its ground/path/plaza/wall material from it, so materials never
 * clash cell-to-cell. Hazards (water/lava/sand) + per-building materials are the only terrain NOT
 * themed. Extracted to its own module so BOTH the program interpreter (scene-program.ts) AND the
 * archetype generators (archetypes.ts) can share it without an import cycle.
 */

import type { LayoutGrammar } from '@mythweaver/shared';

export interface Theme {
  ground: string;
  path: string;
  plaza: string;
  wallMat: 'wood' | 'stone';
}

export const THEMES: Record<string, Theme> = {
  village: { ground: 'grass', path: 'dirt', plaza: 'road', wallMat: 'wood' }, // plaza = the unified cobble (road)
  forest: { ground: 'grass', path: 'dirt', plaza: 'grass', wallMat: 'wood' },
  swamp: { ground: 'grass', path: 'dirt', plaza: 'dirt', wallMat: 'wood' },
  dungeon: { ground: 'stone', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
  crypt: { ground: 'stone_brick', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
  cave: { ground: 'dirt', path: 'dirt', plaza: 'road', wallMat: 'stone' }, // outdoor-ish square → unified cobble
  desert: { ground: 'sand', path: 'dirt', plaza: 'sand', wallMat: 'stone' },
  lava: { ground: 'stone_brick', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
};
export const THEME_NAMES = Object.keys(THEMES);

const THEME_ALIASES: [RegExp, string][] = [
  [/crypt|tomb|catacomb|grave|undead|necro|ossuary/, 'crypt'],
  [/lava|volcano|magma|infernal|molten|brimstone/, 'lava'],
  [/cave|cavern|grotto|warren|\bmine\b|tunnel/, 'cave'],
  [/desert|dune|\bsand|waste|oasis/, 'desert'],
  [/swamp|\bfen\b|marsh|bog|mire|moor/, 'swamp'],
  [/dungeon|vault|prison|jail|fort|castle|keep|citadel|temple|shrine|stone/, 'dungeon'],
  [/forest|wood|grove|glade|jungle|wild|thicket/, 'forest'],
  [/village|town|city|market|hamlet|settlement|square|plaza/, 'village'],
];

// Themes whose GROUND is an enclosed-space floor (cave-dirt / dungeon-stone / crypt / lava). On an
// OUTDOOR settlement these must never win from a brief keyword — a "mining town" or a "temple town" is a
// grass settlement with a mine/temple FEATURE, not a scene floored in cave-dirt. (This is why a coastal
// mining village rendered on monotone orange dirt: "mine" → cave theme → dirt ground everywhere.)
const INTERIOR_THEMES = new Set(['crypt', 'lava', 'cave', 'dungeon']);

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
