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

  it('a COMPOSED (organic multi-wing) temple still reads as a temple — composition is type-agnostic', () => {
    // shape (geometry) is orthogonal to type (furnishing). The rect path is exact-100% (above); composed
    // footprints are ≥95% — the rare miss is a genuinely tiny wing that can't host a full focal (graceful
    // degradation, NOT a silent cap — the shipping town builder uses rect/L/T/U/cross, not compose).
    let clean = 0;
    for (let s = 1; s <= 80; s++) if (checkSemantics(buildComponentSheet('shape:compose:temple', 6, s), 'temple').clean) clean++;
    expect(clean / 80).toBeGreaterThanOrEqual(0.95);
  });

  it('a type with no declared spec is vacuously clean (its station is not built yet)', () => {
    const r = checkSemantics(buildComponentSheet('building:smithy', 6, 1), 'smithy');
    expect(r.clean).toBe(true);
    expect(r.buildings).toBe(0);
  });
});

describe('semantic invariants — building:tavern reads as a tavern (a bar is a RUN focal)', () => {
  it('has ZERO semantic defects across 150 seeds (900 buildings)', () => {
    const dirty: { seed: number; missingFocal: number; focalNotProminent: number; understocked: number }[] = [];
    for (let s = 1; s <= 150; s++) {
      const r = checkSemantics(buildComponentSheet('building:tavern', 6, s), 'tavern');
      if (!r.clean && dirty.length < 8) dirty.push({ seed: s, missingFocal: r.missingFocal, focalNotProminent: r.focalNotProminent, understocked: r.understocked });
    }
    expect(dirty).toEqual([]);
  });

  it('every tavern has a continuous bar counter (≥3 run) + patron seating', () => {
    let buildings = 0;
    for (let s = 1; s <= 40; s++) {
      const r = checkSemantics(buildComponentSheet('building:tavern', 6, s), 'tavern');
      buildings += r.buildings;
      expect(r.missingFocal).toBe(0);
      expect(r.focalNotProminent).toBe(0);
      expect(r.understocked).toBe(0);
      expect(r.keeperOffStation).toBe(0); // the barkeep is always posted AT the bar
    }
    expect(buildings).toBeGreaterThan(100);
  });

  it('catches a broken tavern (the bar counter removed → missingFocal)', () => {
    const m = buildComponentSheet('building:tavern', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'bar_counter') }, 'tavern').missingFocal).toBeGreaterThan(0);
  });

  it('a COMPOSED tavern still mostly reads as a tavern (bonus path; tiny wings degrade)', () => {
    // Rect taverns are exact-100% on EVERY invariant incl. keeper-at-bar (above). Composed footprints are a
    // lab/showcase bonus (the town builder ships rect/L/T/U/cross): in a tiny composed wing the barkeep can't
    // always be posted AT the bar and the run can fall short — a documented degradation, not a silent cap.
    let clean = 0;
    for (let s = 1; s <= 80; s++) if (checkSemantics(buildComponentSheet('shape:compose:tavern', 6, s), 'tavern').clean) clean++;
    expect(clean / 80).toBeGreaterThanOrEqual(0.8);
  });
});
