import { describe, expect, it } from 'vitest';
import { buildComponentSheet } from './component-lab.js';
import { checkSemantics } from './semantic-check.js';

// The SECOND deterministic gate (pairs with structure-check): does a building READ AS its type? Phase F
// builds this out type-by-type; temple is the reference slice (its focal station = altar + ranked pews).
describe('semantic invariants — building:temple reads as a temple (the Phase-F reference slice)', () => {
  it('has ZERO semantic defects across 150 seeds (900 buildings)', () => {
    const dirty: { seed: number; missingFocal: number; focalNotProminent: number; understocked: number }[] = [];
    for (let s = 1; s <= 150; s++) {
      const r = checkSemantics(buildComponentSheet('building:temple', 6, s), 'temple');
      if (!r.clean && dirty.length < 8) dirty.push({ seed: s, missingFocal: r.missingFocal, focalNotProminent: r.focalNotProminent, understocked: r.understocked });
    }
    expect(dirty).toEqual([]);
  });

  it('every temple building has a prominent altar + ≥2 pews', () => {
    let buildings = 0;
    for (let s = 1; s <= 40; s++) {
      const r = checkSemantics(buildComponentSheet('building:temple', 6, s), 'temple');
      buildings += r.buildings;
      expect(r.missingFocal).toBe(0);
      expect(r.focalNotProminent).toBe(0);
      expect(r.understocked).toBe(0);
    }
    expect(buildings).toBeGreaterThan(100); // the sweep actually exercised buildings
  });

  it('catches a broken temple (altar removed → missingFocal; pews removed → understocked)', () => {
    const m = buildComponentSheet('building:temple', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'altar') }, 'temple').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'stone_bench') }, 'temple').understocked).toBeGreaterThan(0);
  });

  it('a type with no declared spec is vacuously clean (its station is not built yet)', () => {
    const r = checkSemantics(buildComponentSheet('building:smithy', 6, 1), 'smithy');
    expect(r.clean).toBe(true);
    expect(r.buildings).toBe(0);
  });
});
