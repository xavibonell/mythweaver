import { describe, expect, it } from 'vitest';
import { compileSpec } from './spec-compile.js';
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
    // The lamp resolved to a real catalog tag (light source).
    expect(r.contents.landmarks.some((l) => l.tag === 'torch_wall')).toBe(true);
    // The party arrives at the east edge.
    expect(r.entryEdge).toBe('east');
    // The weir has no representation — REPORTED, not silently dropped.
    expect(r.unrepresented.join(',')).toContain('weir');
    // Deferred relations are recorded for the provenance panel.
    expect(r.notes.join(' ')).toContain('not yet compiled');
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
