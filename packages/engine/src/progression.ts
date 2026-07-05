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
