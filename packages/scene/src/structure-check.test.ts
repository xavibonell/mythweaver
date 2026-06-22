import { describe, expect, it } from 'vitest';
import { buildComponentSheet } from './component-lab.js';
import { checkStructure } from './structure-check.js';

// Structural invariants over the seed space — the deterministic, $0 regression gate for the town builder
// (pairs with the visual judge, which gates aesthetics). See docs + structure-check.ts.
const BUILDING_TYPES = ['house', 'tavern', 'temple', 'smithy', 'shop'] as const;

function sweep(kind: string, seeds: number) {
  const totals = { leakedInterior: 0, unreachable: 0, freestandingWall: 0, badDoor: 0, wallJog: 0 };
  let dirty: number[] = [];
  for (let s = 1; s <= seeds; s++) {
    const rep = checkStructure(buildComponentSheet(kind, 6, s));
    totals.leakedInterior += rep.leakedInterior;
    totals.unreachable += rep.unreachable;
    totals.freestandingWall += rep.freestandingWall;
    totals.badDoor += rep.badDoor;
    totals.wallJog += rep.wallJog;
    if (!rep.clean && dirty.length < 8) dirty.push(s);
  }
  return { totals, dirty };
}

const ZERO = { leakedInterior: 0, unreachable: 0, freestandingWall: 0, badDoor: 0, wallJog: 0, dirtySeeds: [] };

describe('structure invariants — building:house is structurally perfect (the tuned ceiling)', () => {
  it('has ZERO structural defects across 150 seeds (900 buildings)', () => {
    const { totals, dirty } = sweep('building:house', 150);
    expect({ ...totals, dirtySeeds: dirty }).toEqual(ZERO);
  });
});

describe('structure invariants — every footprint SHAPE is clean (the any-shape building tool)', () => {
  // The headline guarantee: rect / L / T / U / cross all produce a watertight, 1-tile-thick ring with no
  // sealed rooms or doors-to-nowhere — proven over the seed space, not eyeballed.
  for (const sh of ['rect', 'ell', 'tee', 'you', 'plus', 'compose'] as const) {
    it(`shape:${sh} — ZERO structural defects across 80 seeds (480 buildings)`, () => {
      const { totals, dirty } = sweep(`shape:${sh}`, 80);
      expect({ ...totals, dirtySeeds: dirty }).toEqual(ZERO);
    });
  }
});

describe('structure invariants — no building of ANY type leaks (the SEAL pass is universal)', () => {
  // Other types may still have rare connectivity edge-cases (the "move to other components" phase),
  // but the exterior SEAL must hold for every type: a room must never be open to the street.
  for (const t of BUILDING_TYPES) {
    it(`building:${t} — no exterior leak across 60 seeds`, () => {
      expect(sweep(`building:${t}`, 60).totals.leakedInterior).toBe(0);
    });
  }
});
