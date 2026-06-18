import { describe, expect, it } from 'vitest';
import type { RollRequest } from '@mythweaver/shared';
import { diceRange, parseDice, rollDice, validateDeclaredRoll } from './dice.js';

function req(expr: string, extra: Partial<RollRequest> = {}): RollRequest {
  return { id: 'r1', expr, reason: 'test', ...extra };
}

describe('parseDice', () => {
  it('parses NdX+M', () => expect(parseDice('1d20+5')).toEqual({ count: 1, sides: 20, modifier: 5 }));
  it('parses NdX-M', () => expect(parseDice('2d6-1')).toEqual({ count: 2, sides: 6, modifier: -1 }));
  it('parses bare NdX', () => expect(parseDice('8d6')).toEqual({ count: 8, sides: 6, modifier: 0 }));
  it('tolerates whitespace', () => expect(parseDice(' 1 d 20 + 5 ')).toEqual({ count: 1, sides: 20, modifier: 5 }));
  it('rejects malformed input', () => {
    expect(() => parseDice('d20')).toThrow();
    expect(() => parseDice('20')).toThrow();
    expect(() => parseDice('1d1')).toThrow();
  });
});

describe('diceRange', () => {
  it('1d20+5 -> 6..25', () => expect(diceRange(parseDice('1d20+5'))).toEqual({ min: 6, max: 25 }));
  it('2d6 -> 2..12', () => expect(diceRange(parseDice('2d6'))).toEqual({ min: 2, max: 12 }));
  it('8d6-2 -> 6..46', () => expect(diceRange(parseDice('8d6-2'))).toEqual({ min: 6, max: 46 }));
});

describe('rollDice', () => {
  it('stays within range across many rolls', () => {
    for (let i = 0; i < 2000; i++) {
      const v = rollDice('1d20+5');
      expect(v).toBeGreaterThanOrEqual(6);
      expect(v).toBeLessThanOrEqual(25);
    }
  });
  it('advantage never widens the d20 range', () => {
    for (let i = 0; i < 2000; i++) {
      const v = rollDice('1d20+0', 'advantage');
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(20);
    }
  });
  it('is deterministic under an injected RNG', () => {
    expect(rollDice('1d20+2', 'normal', () => 0)).toBe(3); // floor(0*20)+1 = 1, +2
    expect(rollDice('1d20+2', 'normal', () => 0.999999)).toBe(22); // 20 + 2
  });
});

describe('validateDeclaredRoll — dice-trust contract (spec §4.3)', () => {
  it('accepts an in-range declaration', () => {
    const r = validateDeclaredRoll(req('1d20+5'), 18);
    expect(r.validation).toBe('in_range');
    expect(r.accepted).toBe(true);
  });
  it('flags a value above the max', () => {
    const r = validateDeclaredRoll(req('1d20+5'), 30);
    expect(r.validation).toBe('out_of_range');
    expect(r.accepted).toBe(false);
  });
  it('flags a value below the min', () => {
    const r = validateDeclaredRoll(req('1d20+5'), 3);
    expect(r.validation).toBe('out_of_range');
    expect(r.accepted).toBe(false);
  });
  it('accepts an ambiguous value inside the unmodeled-bonus window', () => {
    const r = validateDeclaredRoll(req('1d20+5', { unmodeledBonusMax: 4 }), 27); // base max 25, +4 slack
    expect(r.validation).toBe('ambiguous');
    expect(r.accepted).toBe(true);
    expect(r.unvalidatedModifier).toBe(true);
  });
  it('rejects a value beyond the unmodeled-bonus window', () => {
    const r = validateDeclaredRoll(req('1d20+5', { unmodeledBonusMax: 4 }), 40);
    expect(r.validation).toBe('out_of_range');
    expect(r.accepted).toBe(false);
  });
});

describe('validateDeclaredRoll — DC / success determination (spec §4.2 P1)', () => {
  it('reports success when an accepted roll meets or beats the DC', () => {
    const r = validateDeclaredRoll(req('1d20+5', { dc: 15 }), 17);
    expect(r.accepted).toBe(true);
    expect(r.dc).toBe(15);
    expect(r.success).toBe(true);
  });
  it('treats meeting the DC exactly as success', () => {
    expect(validateDeclaredRoll(req('1d20+5', { dc: 12 }), 12).success).toBe(true);
  });
  it('reports failure when an accepted roll misses the DC', () => {
    expect(validateDeclaredRoll(req('1d20+5', { dc: 18 }), 9).success).toBe(false);
  });
  it('omits success when no DC is given', () => {
    expect(validateDeclaredRoll(req('1d20+5'), 17).success).toBeUndefined();
  });
  it('never reports success for an out-of-range (rejected) roll', () => {
    const r = validateDeclaredRoll(req('1d20+5', { dc: 10 }), 99);
    expect(r.accepted).toBe(false);
    expect(r.success).toBeUndefined();
  });
});
