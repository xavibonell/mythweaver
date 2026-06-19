/**
 * Deterministic CR -> stat-block generator (engine-owned numbers). The Game Director may COMMISSION a
 * brand-new creature by supplying only FICTION — a name, a challenge rating, and flavor (type, attack
 * name, damage type, traits). The ENGINE computes every mechanical value (AC, HP, attack bonus,
 * damage) from a fixed challenge-rating table, so the locked rule still holds: the LLM never invents a
 * number that becomes a mechanical outcome — it only chooses the concept and how hard the fight should be.
 *
 * The table is a sane low-level curve calibrated to the authored bestiary (goblin CR 1/4 ≈ 13 HP,
 * giant spider CR 1 ≈ 30 HP), NOT the DMG defensive-CR table (whose HP bands are far higher).
 */

import type { AbilityScores, AttackAction, Condition, DamageType, DiceExpr, StatBlock } from '@mythweaver/shared';

/** Fiction the Director supplies; everything mechanical is derived from `challengeRating`. */
export interface MonsterSpec {
  name: string;
  challengeRating: number;
  id?: string;
  size?: StatBlock['size'];
  type?: string;
  /** Flavor only — biases the synthesized ability spread. */
  primaryAbility?: 'str' | 'dex';
  attackName?: string;
  damageType?: DamageType;
  ranged?: boolean;
  reachOrRangeFt?: number;
  traits?: { name: string; text: string }[];
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  damageVulnerabilities?: DamageType[];
  conditionImmunities?: Condition[];
  source?: string;
}

interface Rung {
  cr: number;
  ac: number;
  hp: number;
  atk: number;
  dmg: number;
  prof: number;
}

// CR rung -> defensive/offensive targets (AC, average HP, attack bonus, average damage/round, prof).
const RUNGS: Rung[] = [
  { cr: 0, ac: 12, hp: 4, atk: 3, dmg: 2, prof: 2 },
  { cr: 0.125, ac: 12, hp: 8, atk: 3, dmg: 3, prof: 2 },
  { cr: 0.25, ac: 13, hp: 13, atk: 4, dmg: 5, prof: 2 },
  { cr: 0.5, ac: 13, hp: 22, atk: 4, dmg: 7, prof: 2 },
  { cr: 1, ac: 13, hp: 30, atk: 4, dmg: 10, prof: 2 },
  { cr: 2, ac: 14, hp: 45, atk: 5, dmg: 14, prof: 2 },
  { cr: 3, ac: 14, hp: 65, atk: 5, dmg: 18, prof: 2 },
  { cr: 4, ac: 15, hp: 85, atk: 6, dmg: 22, prof: 3 },
  { cr: 5, ac: 15, hp: 110, atk: 6, dmg: 26, prof: 3 },
];

const DAMAGE_TYPES: ReadonlySet<string> = new Set([
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
]);

/** Nearest rung by challenge rating (ties → lower CR). */
function rungFor(cr: number): Rung {
  const c = Math.max(0, Math.min(5, cr));
  let best = RUNGS[0]!;
  for (const r of RUNGS) if (Math.abs(r.cr - c) < Math.abs(best.cr - c)) best = r;
  return best;
}

/** Build an `NdS+M` formula whose average ≈ target. */
function formulaFor(target: number, sides: number): { formula: DiceExpr; average: number } {
  const per = (sides + 1) / 2;
  const n = Math.max(1, Math.round(target / (per + 1)));
  const bonus = Math.max(0, Math.round(target - n * per));
  const formula = bonus > 0 ? `${n}d${sides}+${bonus}` : `${n}d${sides}`;
  return { formula, average: Math.round(n * per + bonus) };
}

function slug(name: string): string {
  return (name || 'creature').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'creature';
}

const filterDamage = (a: unknown): DamageType[] | undefined => {
  if (!Array.isArray(a)) return undefined;
  const out = a.filter((d): d is DamageType => typeof d === 'string' && DAMAGE_TYPES.has(d));
  return out.length ? out : undefined;
};

/**
 * Generate a validated StatBlock from a fiction spec + its challenge rating. Pure/deterministic:
 * same spec ⇒ same numbers. The engine owns every value here.
 */
export function generateStatBlock(spec: MonsterSpec): StatBlock {
  const cr = Number.isFinite(spec.challengeRating) ? Math.max(0, Math.min(30, spec.challengeRating)) : 0.25;
  const r = rungFor(cr);
  const hp = formulaFor(r.hp, 8);
  const dmg = formulaFor(r.dmg, 6);
  const primary = spec.primaryAbility === 'dex' ? 'dex' : 'str';
  const lift = Math.min(6, Math.round(cr));
  const abilities: AbilityScores = {
    str: primary === 'str' ? 13 + lift : 11,
    dex: primary === 'dex' ? 13 + lift : 12,
    con: 12 + lift,
    int: 6,
    wis: 10,
    cha: 8,
  };
  const damageType: DamageType = spec.damageType && DAMAGE_TYPES.has(spec.damageType) ? spec.damageType : 'bludgeoning';
  const attack: AttackAction = {
    name: (spec.attackName || 'Strike').slice(0, 60),
    attackBonus: r.atk,
    damage: dmg.formula,
    damageType,
    reachOrRangeFt: spec.reachOrRangeFt ?? (spec.ranged ? 60 : 5),
  };
  return {
    id: spec.id ? slug(spec.id) : slug(spec.name),
    name: (spec.name || 'Creature').slice(0, 60),
    size: spec.size ?? 'medium',
    type: (spec.type || 'monstrosity').slice(0, 60),
    armorClass: r.ac,
    hitPoints: { average: hp.average, formula: hp.formula },
    speedFt: 30,
    abilities,
    challengeRating: cr,
    proficiencyBonus: r.prof,
    ...(spec.damageResistances ? { damageResistances: filterDamage(spec.damageResistances) ?? [] } : {}),
    ...(filterDamage(spec.damageImmunities) ? { damageImmunities: filterDamage(spec.damageImmunities)! } : {}),
    ...(filterDamage(spec.damageVulnerabilities) ? { damageVulnerabilities: filterDamage(spec.damageVulnerabilities)! } : {}),
    attacks: [attack],
    ...(Array.isArray(spec.traits) && spec.traits.length
      ? { traits: spec.traits.slice(0, 4).map((t) => ({ name: String(t.name || '').slice(0, 60), text: String(t.text || '').slice(0, 300) })).filter((t) => t.name) }
      : {}),
    source: spec.source || 'generated',
  };
}
