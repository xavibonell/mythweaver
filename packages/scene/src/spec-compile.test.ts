import { describe, expect, it } from 'vitest';
import { applySpecPlacement, compileSpec } from './spec-compile.js';
import { normalizeProgram, runProgram } from './scene-program.js';
import type { SceneSpec } from '@mythweaver/shared';

/** The drowned-bell beat-1 shape: stilt shacks, a jetty, a boathouse, drowned dead IN the water. */
const BEAT1: SceneSpec = {
  specVersion: 1,
  brief: 'a stilt shanty-town on a black reservoir shore',
  frame: { grammar: 'settlement', entry: { edge: 'east', pose: 'arriving' } },
  conditions: [{ profile: 'dusk' }, { profile: 'fog' }],
  features: [
    { id: 'shacks', kind: 'building.stilted-shack', geom: 'region', count: 7 },
    { id: 'jetty', kind: 'dock.jetty', geom: 'network', count: 3 },
    { id: 'boathouse', kind: 'building.boathouse', geom: 'region' },
    { id: 'drowned', kind: 'actor.drowned-dead', geom: 'point', count: 4 },
    { id: 'lamp', kind: 'prop.lamp-post', geom: 'point' },
    { id: 'weir', kind: 'structure.weir', geom: 'edge-profile' },
  ],
  constraints: [
    { c: 'at-edge-of', a: 'jetty', region: 'water', w: 'hard' },
    { c: 'in', a: 'drowned', region: 'water', w: 'hard' },
    { c: 'near', a: 'boathouse', b: 'jetty', w: 'hard' },
    { c: 'near', a: 'PARTY', b: 'jetty', w: 'story' },
  ],
};

describe('compileSpec — the deterministic spec→ops consumer (S2 v1)', () => {
  it('features become contents/flags/ops losslessly: buildings, frontier, in-water actors, entry', () => {
    const r = compileSpec(BEAT1, { settlement: true });
    // 7 shacks + the boathouse — the named cast, not a keyword harvest.
    expect(r.contents.buildings.filter((b) => b.type === 'house')).toHaveLength(7);
    expect(r.contents.buildings.some((b) => b.type === 'workshop')).toBe(true);
    // The jetty became the coast+port frontier.
    expect(r.contents.coast).toBe(true);
    expect(r.contents.port).toBe(true);
    // The drowned dead scatter IN the water as hostiles.
    const wet = r.postOps.find((o) => o.op === 'scatter' && o.on === 'water');
    expect(wet).toMatchObject({ kind: 'actor', role: 'mob', count: 4 });
    // The lamp resolved to a real catalog tag (light source) as an addressable op (S4).
    expect(r.postOps.some((o) => o.op === 'place' && o.tag === 'torch_wall' && o.id === 'prop:lamp')).toBe(true);
    // The party arrives at the east edge.
    expect(r.entryEdge).toBe('east');
    // The weir has no representation — REPORTED, not silently dropped.
    expect(r.unrepresented.join(',')).toContain('weir');
    // Remaining relations are queued for the placement pass (S4), visibly.
    expect(r.notes.join(' ')).toContain('queued for the placement pass');
  });

  it('non-settlement specs realize as loose ops (no archetype available)', () => {
    const spec: SceneSpec = {
      specVersion: 1,
      brief: 'a flooded church nave',
      frame: { grammar: 'interior', entry: { edge: 'south' } },
      features: [
        { id: 'bell', kind: 'prop.great-bell', geom: 'point' },
        { id: 'revenant', kind: 'actor.revenant', geom: 'point' },
        { id: 'coffins', kind: 'prop.coffin', geom: 'point', count: 4 },
      ],
      constraints: [{ c: 'in', a: 'coffins', region: 'water', w: 'hard' }],
    };
    const r = compileSpec(spec, { settlement: false });
    // No bell art exists → honestly unrepresented (the ART WALL, not a silent drop).
    expect(r.unrepresented.join(',')).toContain('bell');
    // The revenant scatters as a hostile; the coffins float as sarcophagi in the water.
    expect(r.postOps.some((o) => o.op === 'scatter' && o.kind === 'actor' && o.role === 'mob')).toBe(true);
    const floats = r.postOps.find((o) => o.op === 'scatter' && o.on === 'water');
    expect(floats).toMatchObject({ kind: 'prop', count: 4, tags: ['sarcophagus'] });
  });

  it('end-to-end: a spec-compiled water scatter puts actors ON water tiles', () => {
    // A minimal program with a water band; the in-water scatter must land on it.
    const p = normalizeProgram(
      { cols: 30, rows: 20, grammar: 'open-outdoor', outdoor: true, ops: [{ op: 'fill', region: { x: 20, y: 0, w: 10, h: 20 }, tag: 'water' }] },
      'a black reservoir shore', 'dusk fog', 'wild',
    );
    const r = compileSpec(BEAT1, { settlement: false });
    p.ops.push(...r.postOps.filter((o) => o.op === 'scatter' && o.on === 'water'));
    const m = runProgram(p);
    const wet = m.objects.filter((o) => o.group?.includes('drowned'));
    expect(wet.length).toBeGreaterThan(0);
    for (const o of wet) expect(m.tiles[o.row]![o.col]!.startsWith('water')).toBe(true);
  });
});

describe('S4 — relation placement', () => {
  it('near(building, dock) marks the building WATERFRONT (lot bias, compiled at town time)', () => {
    const r = compileSpec(BEAT1, { settlement: true });
    const boathouse = r.contents.buildings.find((b) => b.name === 'boathouse');
    expect(boathouse?.waterfront).toBe(true);
    // The shacks have no water relation — they keep normal lots.
    expect(r.contents.buildings.filter((b) => b.type === 'house').every((b) => !b.waterfront)).toBe(true);
    expect(r.notes.join(' ')).toContain('waterfront lot');
  });

  it('single landmark props always become addressable place ops (towns drop landmark contents)', () => {
    const r = compileSpec(BEAT1, { settlement: true });
    const lamp = r.postOps.find((o) => o.op === 'place' && o.id === 'prop:lamp');
    expect(lamp).toBeTruthy();
    expect(r.contents.landmarks).toHaveLength(0);
  });

  it('applySpecPlacement moves point realizations to satisfy near/along and stages the PARTY', () => {
    // Build a simple map: water column east, a dock ambiance strip, pcs at the west edge,
    // a lamp prop far from the dock, boats far from the dock.
    const p = normalizeProgram(
      { cols: 30, rows: 20, grammar: 'open-outdoor', outdoor: true, ops: [{ op: 'fill', region: { x: 24, y: 0, w: 6, h: 20 }, tag: 'water' }] },
      'a shore', 'day', 'wild',
    );
    p.ops.push(
      { op: 'place', id: 'prop:lamp', tag: 'signpost', kind: 'prop', at: { c: 2, r: 2 }, name: 'lamp' },
      { op: 'scatter', idBase: 'prop:rowboats', tags: ['boat'], kind: 'prop', region: { x: 0, y: 0, w: 6, h: 6 }, count: 2 },
      { op: 'place', id: 'pc:a', tag: 'knight', kind: 'actor', role: 'pc', at: 'west', name: 'A' },
      { op: 'place', id: 'pc:b', tag: 'wizard', kind: 'actor', role: 'pc', at: 'west', name: 'B' },
    );
    const m = runProgram(p);
    // Fake a dock strip in the water-adjacent band (the port frontier normally does this).
    for (let r = 8; r < 12; r++) m.ambiance.push({ tag: 'dock_ns', col: 23, row: r });

    const spec: SceneSpec = {
      specVersion: 1,
      brief: 'x',
      frame: { grammar: 'wild', entry: { edge: 'west' } },
      features: [
        { id: 'dock1', kind: 'dock.long', geom: 'network' },
        { id: 'lamp', kind: 'prop.lamp-post', geom: 'point' },
        { id: 'rowboats', kind: 'prop.rowboat', geom: 'point', count: 2 },
      ],
      constraints: [
        { c: 'near', a: 'lamp', b: 'dock1', w: 'story' },
        { c: 'along', a: 'rowboats', b: 'dock1', w: 'story' },
        { c: 'near', a: 'PARTY', b: 'dock1', w: 'story' },
        { c: 'facing', a: 'lamp', b: 'PARTY', w: 'soft' }, // deferred, honestly
      ],
    };
    const notes = applySpecPlacement(m, spec);
    const lamp = m.objects.find((o) => o.id === 'prop:lamp')!;
    expect(Math.abs(lamp.col - 23)).toBeLessThanOrEqual(6); // beside the dock now
    for (const pc of m.objects.filter((o) => o.role === 'pc')) expect(Math.abs(pc.col - 23)).toBeLessThanOrEqual(6); // the party stands at the dock
    for (const b of m.objects.filter((o) => o.group === 'prop:rowboats')) expect(Math.abs(b.col - 23)).toBeLessThanOrEqual(6); // boats along it
    expect(notes.some((n) => n.includes('facing') && n.includes('deferred'))).toBe(true);
    expect(notes.filter((n) => n.includes('moved')).length).toBeGreaterThanOrEqual(3);
  });
});
