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
  village: { ground: 'grass', path: 'dirt', plaza: 'stone', wallMat: 'wood' },
  forest: { ground: 'grass', path: 'dirt', plaza: 'grass', wallMat: 'wood' },
  swamp: { ground: 'grass', path: 'dirt', plaza: 'dirt', wallMat: 'wood' },
  dungeon: { ground: 'stone', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
  crypt: { ground: 'stone_brick', path: 'stone', plaza: 'flagstone', wallMat: 'stone' },
  cave: { ground: 'dirt', path: 'dirt', plaza: 'stone', wallMat: 'stone' },
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

/** Resolve a theme name (or infer from the brief) to a Theme key. */
export function themeNameFor(name: unknown, brief: string, grammar: LayoutGrammar): string {
  if (typeof name === 'string' && THEMES[name.toLowerCase()]) return name.toLowerCase();
  const lc = `${typeof name === 'string' ? name : ''} ${brief}`.toLowerCase();
  for (const [re, t] of THEME_ALIASES) if (re.test(lc)) return t;
  return grammar === 'enclosed-interior' ? 'dungeon' : 'village';
}
