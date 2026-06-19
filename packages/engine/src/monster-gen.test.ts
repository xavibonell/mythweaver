import { describe, expect, it } from 'vitest';
import { generateStatBlock } from './monster-gen.js';
import { parseDice } from './dice.js';

describe('generateStatBlock (engine owns the numbers)', () => {
  it('is deterministic — same spec yields the same stat block', () => {
    const a = generateStatBlock({ name: 'Drowned Wraith', challengeRating: 1, damageType: 'necrotic', type: 'undead' });
    const b = generateStatBlock({ name: 'Drowned Wraith', challengeRating: 1, damageType: 'necrotic', type: 'undead' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('scales HP / AC up with challenge rating', () => {
    const low = generateStatBlock({ name: 'Imp', challengeRating: 0.125 });
    const high = generateStatBlock({ name: 'Ogre', challengeRating: 3 });
    expect(high.hitPoints.average).toBeGreaterThan(low.hitPoints.average);
    expect(high.armorClass).toBeGreaterThanOrEqual(low.armorClass);
  });

  it('emits a parseable HP formula whose mean ≈ the stated average', () => {
    const sb = generateStatBlock({ name: 'Brute', challengeRating: 2 });
    const p = parseDice(sb.hitPoints.formula); // throws if the formula is invalid
    const mean = (p.count * (1 + p.sides)) / 2 + p.modifier;
    expect(Math.abs(mean - sb.hitPoints.average)).toBeLessThanOrEqual(6);
  });

  it('keeps the engine in charge: only one attack, attackBonus from the CR table, parseable damage', () => {
    const sb = generateStatBlock({ name: 'Skitterer', challengeRating: 1, attackName: 'Bite', damageType: 'piercing', ranged: false });
    expect(sb.attacks.length).toBe(1);
    expect(sb.attacks[0]!.name).toBe('Bite');
    expect(sb.attacks[0]!.damageType).toBe('piercing');
    expect(() => parseDice(sb.attacks[0]!.damage)).not.toThrow();
    expect(sb.attacks[0]!.attackBonus).toBeGreaterThan(0);
  });

  it('rejects a bogus damage type, falling back to bludgeoning', () => {
    const sb = generateStatBlock({ name: 'Thing', challengeRating: 1, damageType: 'spooky' as never });
    expect(sb.attacks[0]!.damageType).toBe('bludgeoning');
  });

  it('slugifies an id from the name and stamps a source', () => {
    const sb = generateStatBlock({ name: "Maren's Drowned Lure", challengeRating: 0.5 });
    expect(sb.id).toMatch(/^[a-z0-9-]+$/);
    expect(sb.source).toBeTruthy();
  });
});
