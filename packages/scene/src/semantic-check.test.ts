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

  it('a type with no declared spec is vacuously clean (the kernel only gates types with a contract)', () => {
    const r = checkSemantics(buildComponentSheet('building:house', 6, 1), 'house'); // house is a residence — no single focal spec
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
    expect(clean / 80).toBeGreaterThanOrEqual(0.6); // stricter since the servable-counter invariant flags flush counters in tiny composed wings
  });
});

describe('semantic invariants — building:smithy reads as a smithy (forge + anvil STATION)', () => {
  it('has ZERO semantic defects across 150 seeds (900 buildings)', () => {
    const dirty: { seed: number; missingFocal: number; focalNotProminent: number; keeperOffStation: number }[] = [];
    for (let s = 1; s <= 150; s++) {
      const r = checkSemantics(buildComponentSheet('building:smithy', 6, s), 'smithy');
      if (!r.clean && dirty.length < 8) dirty.push({ seed: s, missingFocal: r.missingFocal, focalNotProminent: r.focalNotProminent, keeperOffStation: r.keeperOffStation });
    }
    expect(dirty).toEqual([]);
  });

  it('every smithy has a forge with its anvil adjacent + the smith posted at it', () => {
    let buildings = 0;
    for (let s = 1; s <= 40; s++) {
      const r = checkSemantics(buildComponentSheet('building:smithy', 6, s), 'smithy');
      buildings += r.buildings;
      expect(r.missingFocal).toBe(0);       // a forge is present
      expect(r.focalNotProminent).toBe(0);  // the anvil is by the forge
      expect(r.keeperOffStation).toBe(0);   // the smith is at the forge
    }
    expect(buildings).toBeGreaterThan(100);
  });

  it('catches a broken smithy (forge removed → missingFocal; anvil removed → focalNotProminent)', () => {
    const m = buildComponentSheet('building:smithy', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'forge') }, 'smithy').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'anvil') }, 'smithy').focalNotProminent).toBeGreaterThan(0);
  });

  it('a COMPOSED smithy is structurally sound but the forge STATION degrades most in tiny wings (bonus path)', () => {
    // The forge+anvil+smith cluster is the most space-demanding focal; on a composed partition wall an
    // inter-room arch can shear it apart. Rect smithy is exact-100% (the shipping path); composed is a known-
    // weaker bonus we keep honest here rather than hide. Follow-up: anchor focal stations on the outer ring.
    let clean = 0;
    for (let s = 1; s <= 80; s++) if (checkSemantics(buildComponentSheet('shape:compose:smithy', 6, s), 'smithy').clean) clean++;
    expect(clean / 80).toBeGreaterThanOrEqual(0.5);
  });
});

describe('semantic invariants — building:shop reads as a shop (service counter + display wares)', () => {
  it('has ZERO semantic defects across 150 seeds (900 buildings)', () => {
    const dirty: { seed: number; missingFocal: number; focalNotProminent: number; understocked: number; keeperOffStation: number }[] = [];
    for (let s = 1; s <= 150; s++) {
      const r = checkSemantics(buildComponentSheet('building:shop', 6, s), 'shop');
      if (!r.clean && dirty.length < 8) dirty.push({ seed: s, missingFocal: r.missingFocal, focalNotProminent: r.focalNotProminent, understocked: r.understocked, keeperOffStation: r.keeperOffStation });
    }
    expect(dirty).toEqual([]);
  });

  it('every shop has a service counter + ≥2 display ware-shelves + the shopkeeper at the counter', () => {
    let buildings = 0;
    for (let s = 1; s <= 40; s++) {
      const r = checkSemantics(buildComponentSheet('building:shop', 6, s), 'shop');
      buildings += r.buildings;
      expect(r.missingFocal).toBe(0);
      expect(r.focalNotProminent).toBe(0);
      expect(r.understocked).toBe(0);
      expect(r.keeperOffStation).toBe(0);
    }
    expect(buildings).toBeGreaterThan(100);
  });

  it('catches a broken shop (counter removed → missingFocal; wares removed → understocked)', () => {
    const m = buildComponentSheet('building:shop', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'bar_counter') }, 'shop').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'shelf_wares') }, 'shop').understocked).toBeGreaterThan(0);
  });

  it('a COMPOSED shop mostly reads as a shop (bonus path; tiny wings degrade)', () => {
    let clean = 0;
    for (let s = 1; s <= 80; s++) if (checkSemantics(buildComponentSheet('shape:compose:shop', 6, s), 'shop').clean) clean++;
    expect(clean / 80).toBeGreaterThanOrEqual(0.55);
  });
});
