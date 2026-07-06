/**
 * The Character Engine's SRD PROGRESSION tables (P3 foundation) — a sibling of monster-gen.ts.
 *
 * Mechanical character numbers are computed from FIXED DATA, never LLM-supplied: exactly the "engine owns
 * numbers from a table" precedent generateStatBlock established for monsters, applied to characters. P3a
 * needs only the hit-die-by-class lookup (for rests + display); the XP-threshold / proficiency-by-level /
 * per-class slot tables land with leveling in P3c.
 */

/** SRD hit-die size by class name (case-insensitive). Anything unrecognized defaults to a d8. */
const HIT_DIE_BY_CLASS: Record<string, number> = {
  barbarian: 12,
  fighter: 10,
  paladin: 10,
  ranger: 10,
  bard: 8,
  cleric: 8,
  druid: 8,
  monk: 8,
  rogue: 8,
  warlock: 8,
  artificer: 8,
  sorcerer: 6,
  wizard: 6,
};

export const hitDieForClass = (className: string): number => HIT_DIE_BY_CLASS[className.trim().toLowerCase()] ?? 8;

// --- P3c: XP + leveling (SRD tables, engine-owned) -------------------------

/** SRD cumulative XP required to REACH each level. Index = level (1–20); index 0 is unused padding. */
export const XP_THRESHOLDS: readonly number[] = [
  0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

/** The highest character level (1–20) a given total XP supports. */
export const levelForXp = (totalXp: number): number => {
  let level = 1;
  for (let l = 2; l <= 20; l++) {
    if (totalXp >= XP_THRESHOLDS[l]!) level = l;
    else break;
  }
  return level;
};

/** Fixed ("average") hit points gained per level for a die of the given size: floor(size/2)+1
 *  (d6→4, d8→5, d10→6, d12→7). Add the CON modifier for the real gain. */
export const hitDieAvg = (size: number): number => Math.floor(size / 2) + 1;

/** Levels at which most classes gain an Ability Score Improvement / feat. Class-specific extras
 *  (Fighter 6/14, Rogue 10) are deferred — flagged, not auto-applied, so pacing/agency stay the table's. */
export const ASI_LEVELS: readonly number[] = [4, 8, 12, 16, 19];
