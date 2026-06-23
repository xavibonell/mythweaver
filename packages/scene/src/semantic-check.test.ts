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

// ── P0 batch (the next five most adventure-central location types). Each is a focal-station slice on the
// same kernel as smithy/shop: general_store + cathedral are exact-100% (their stations place plenty); inn,
// jail and vault have a tiny-footprint tail (their defining BLOCK — beds / a cell row / a chest hoard — needs
// more room than one focal prop, so a 4×4 lab footprint degrades gracefully; shipping town footprints are full).

describe('semantic invariants — building:general_store reads as a provisioner (counter + dense stock)', () => {
  it('has ZERO semantic defects across 150 seeds', () => {
    const dirty: number[] = [];
    for (let s = 1; s <= 150; s++) if (!checkSemantics(buildComponentSheet('building:general_store', 6, s), 'general_store').clean && dirty.length < 8) dirty.push(s);
    expect(dirty).toEqual([]);
  });
  it('catches a broken store (counter removed → missingFocal; wares removed → understocked)', () => {
    const m = buildComponentSheet('building:general_store', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'bar_counter') }, 'general_store').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'shelf_wares') }, 'general_store').understocked).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:cathedral reads as a cathedral (grand altar + ranked pews)', () => {
  it('has ZERO semantic defects across 150 seeds', () => {
    const dirty: number[] = [];
    for (let s = 1; s <= 150; s++) if (!checkSemantics(buildComponentSheet('building:cathedral', 6, s), 'cathedral').clean && dirty.length < 8) dirty.push(s);
    expect(dirty).toEqual([]);
  });
  it('catches a broken cathedral (altar removed → missingFocal; pews removed → understocked)', () => {
    const m = buildComponentSheet('building:cathedral', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'altar') }, 'cathedral').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'stone_bench') }, 'cathedral').understocked).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:inn reads as an inn (check-in counter + rentable beds)', () => {
  it('reads as an inn on ≥92% of seeds (tiny single-room footprints degrade gracefully)', () => {
    let clean = 0;
    for (let s = 1; s <= 150; s++) if (checkSemantics(buildComponentSheet('building:inn', 6, s), 'inn').clean) clean++;
    expect(clean / 150).toBeGreaterThanOrEqual(0.92);
  });
  it('catches a broken inn (counter removed → missingFocal; all beds removed → understocked)', () => {
    const m = buildComponentSheet('building:inn', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'bar_counter') }, 'inn').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => !o.tag.startsWith('bed')) }, 'inn').understocked).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:jail reads as a jail (a block of caged cells)', () => {
  it('reads as a jail on ≥93% of seeds (a 3-wide footprint cannot host a 2-cell block — graceful)', () => {
    let clean = 0;
    for (let s = 1; s <= 150; s++) if (checkSemantics(buildComponentSheet('building:jail', 6, s), 'jail').clean) clean++;
    expect(clean / 150).toBeGreaterThanOrEqual(0.93);
  });
  it('catches a broken jail (the cages removed → missingFocal)', () => {
    const m = buildComponentSheet('building:jail', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'cage') }, 'jail').missingFocal).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:vault reads as a vault (a hoard of strongboxes)', () => {
  it('reads as a vault on ≥98% of seeds', () => {
    let clean = 0;
    for (let s = 1; s <= 150; s++) if (checkSemantics(buildComponentSheet('building:vault', 6, s), 'vault').clean) clean++;
    expect(clean / 150).toBeGreaterThanOrEqual(0.98);
  });
  it('catches a broken vault (the chests removed → missingFocal)', () => {
    const m = buildComponentSheet('building:vault', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'chest') }, 'vault').missingFocal).toBeGreaterThan(0);
  });
});

// ── P1 batch (faction / military / intrigue / lair). Same kernel; all reuse-only props. keep/library/barracks/
// guildhall/goblin_warren are exact-100% over 150 seeds; armory has the usual tiny-footprint tail. manor is a
// grand multi-room residence with NO focal spec (vacuously clean, like house) — its read comes from the recipe.

describe('semantic invariants — building:keep reads as a great hall (a throne + feast seating)', () => {
  it('reads as a keep on ≥90% of seeds (tiny great halls degrade)', () => {
    let clean = 0;
    for (let s = 1; s <= 150; s++) if (checkSemantics(buildComponentSheet('building:keep', 6, s), 'keep').clean) clean++;
    expect(clean / 150).toBeGreaterThanOrEqual(0.9);
  });
  it('catches a broken keep (the throne removed → missingFocal)', () => {
    const m = buildComponentSheet('building:keep', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'throne') }, 'keep').missingFocal).toBeGreaterThan(0);
  });
  it('a keep does NOT read as a goblin warren — the two throne-types have distinct contracts (no cage in a keep)', () => {
    // a clean keep (throne + feast chairs, no cage) must FAIL the warren contract, else the checker can't tell a palace from a lair.
    let confused = 0;
    for (let s = 1; s <= 60; s++) { const m = buildComponentSheet('building:keep', 6, s); if (checkSemantics(m, 'keep').clean && checkSemantics(m, 'goblin_warren').clean) confused++; }
    expect(confused).toBe(0);
  });
});

describe('semantic invariants — building:library reads as a library (rows of full bookshelves)', () => {
  it('has ZERO semantic defects across 150 seeds', () => {
    const dirty: number[] = [];
    for (let s = 1; s <= 150; s++) if (!checkSemantics(buildComponentSheet('building:library', 6, s), 'library').clean && dirty.length < 8) dirty.push(s);
    expect(dirty).toEqual([]);
  });
  it('catches a broken library (shelves removed → missingFocal)', () => {
    const m = buildComponentSheet('building:library', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'bookshelf_full') }, 'library').missingFocal).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:armory reads as an arsenal (ranks of weapon racks)', () => {
  it('reads as an armory on ≥97% of seeds (tiny footprints can\'t host 2 racks — graceful)', () => {
    let clean = 0;
    for (let s = 1; s <= 150; s++) if (checkSemantics(buildComponentSheet('building:armory', 6, s), 'armory').clean) clean++;
    expect(clean / 150).toBeGreaterThanOrEqual(0.97);
  });
  it('catches a broken armory (the weapon racks removed → missingFocal)', () => {
    const m = buildComponentSheet('building:armory', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'weapon_rack') }, 'armory').missingFocal).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:barracks reads as a dormitory (rows of bunks)', () => {
  it('has ZERO semantic defects across 150 seeds', () => {
    const dirty: number[] = [];
    for (let s = 1; s <= 150; s++) if (!checkSemantics(buildComponentSheet('building:barracks', 6, s), 'barracks').clean && dirty.length < 8) dirty.push(s);
    expect(dirty).toEqual([]);
  });
  it('catches a broken barracks (all bunks removed → missingFocal)', () => {
    const m = buildComponentSheet('building:barracks', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => !o.tag.startsWith('bed')) }, 'barracks').missingFocal).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:guildhall reads as a guildhall (the guild crest + meeting table)', () => {
  it('has ZERO semantic defects across 150 seeds', () => {
    const dirty: number[] = [];
    for (let s = 1; s <= 150; s++) if (!checkSemantics(buildComponentSheet('building:guildhall', 6, s), 'guildhall').clean && dirty.length < 8) dirty.push(s);
    expect(dirty).toEqual([]);
  });
  it('catches a broken guildhall (the crest removed → missingFocal)', () => {
    const m = buildComponentSheet('building:guildhall', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'banner') }, 'guildhall').missingFocal).toBeGreaterThan(0);
  });
});

describe('semantic invariants — building:goblin_warren reads as a lair (chief\'s seat + a prisoner cage)', () => {
  it('reads as a warren on ≥93% of seeds (tiny lairs degrade)', () => {
    let clean = 0;
    for (let s = 1; s <= 150; s++) if (checkSemantics(buildComponentSheet('building:goblin_warren', 6, s), 'goblin_warren').clean) clean++;
    expect(clean / 150).toBeGreaterThanOrEqual(0.93);
  });
  it('catches a broken warren (chief\'s seat removed → missingFocal; cages removed → understocked)', () => {
    const m = buildComponentSheet('building:goblin_warren', 6, 1);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'throne') }, 'goblin_warren').missingFocal).toBeGreaterThan(0);
    expect(checkSemantics({ ...m, objects: m.objects.filter((o) => o.tag !== 'cage') }, 'goblin_warren').understocked).toBeGreaterThan(0);
  });
  it('a goblin warren does NOT read as a keep — a lair (with cages, no feast chairs) is not a great hall', () => {
    let confused = 0;
    for (let s = 1; s <= 60; s++) { const m = buildComponentSheet('building:goblin_warren', 6, s); if (checkSemantics(m, 'goblin_warren').clean && checkSemantics(m, 'keep').clean) confused++; }
    expect(confused).toBe(0);
  });
});

describe('semantic invariants — building:manor is a grand residence (no focal spec, like house)', () => {
  it('is vacuously clean (a residence has no single mandated focal — its read is the multi-room recipe)', () => {
    const r = checkSemantics(buildComponentSheet('building:manor', 6, 1), 'manor');
    expect(r.clean).toBe(true);
    expect(r.buildings).toBe(0);
  });
});
