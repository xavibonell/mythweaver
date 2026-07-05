import { describe, expect, it } from 'vitest';
import { validateSceneSpec } from './scene-spec.js';

// The L0 emission gate (Weave). Proves the SceneSpec validator accepts a well-formed spec (incl. the Vurel
// shape), catches the real emission failure modes, and — the R2 ergonomics fix — treats the PARTY / frame as
// the implicit object of a binary relation (the failure class that held the emission trial at 85%).

const base = { specVersion: 1 as const, brief: 'x', frame: { grammar: 'settlement' as const }, features: [{ id: 'a', kind: 'building.house', geom: 'region' as const }] };

describe('SceneSpec validator (Weave L0)', () => {
  it('accepts the Vurel canal spec (through-fabric, across-via, side-of-PARTY, story tier)', () => {
    const spec = {
      specVersion: 1, brief: 'Vurel', frame: { grammar: 'settlement', entry: { edge: 'south' } },
      conditions: [{ profile: 'abandonment', value: 0.8 }],
      features: [
        { id: 'canal1', kind: 'waterway.canal', geom: 'network' },
        { id: 'row1', kind: 'building.house', geom: 'region', count: 3 },
        { id: 'door1', kind: 'doorway', geom: 'point' },
      ],
      constraints: [
        { c: 'through-fabric', f: 'canal1', w: 'hard' },
        { c: 'crossable', f: 'canal1', at: 'circulation', w: 'hard' },
        { c: 'across', a: 'row1', b: 'PARTY', via: 'canal1', w: 'hard' },
        { c: 'side', a: 'door1', of: 'PARTY', dir: 'right', paces: 3, w: 'story' },
      ],
      tableaux: [{ id: 't1', pattern: 'doorway-figure', focus: 'door1', roles: {} }],
      narrationOnly: ['a bell that does not ring'],
    };
    expect(validateSceneSpec(spec)).toEqual({ ok: true, violations: [], warnings: [] });
  });

  it('R2 ergonomics: a binary relation with the object omitted is valid (implicit PARTY / frame)', () => {
    // the exact failure class that held the trial at 85% — "physician near", "cots in [the ward]"
    const spec = { ...base, constraints: [{ c: 'near', a: 'a', w: 'soft' }, { c: 'in', a: 'a', w: 'story' }, { c: 'facing', a: 'a', w: 'soft' }] };
    expect(validateSceneSpec(spec).ok).toBe(true);
  });

  it('catches unknown relations, dangling refs, and the unsat across+near hard pair', () => {
    expect(validateSceneSpec({ ...base, constraints: [{ c: 'beside', a: 'a', b: 'PARTY', w: 'soft' }] }).violations[0]!.code).toBe('bad-relation');
    expect(validateSceneSpec({ ...base, constraints: [{ c: 'near', a: 'a', b: 'ghost', w: 'soft' }] }).violations[0]!.code).toBe('dangling-ref');
    const unsat = validateSceneSpec({ ...base, features: [{ id: 'a', kind: 'x', geom: 'region' }, { id: 'b', kind: 'y', geom: 'region' }], constraints: [{ c: 'across', a: 'a', b: 'b', w: 'hard' }, { c: 'near', a: 'a', b: 'b', w: 'hard' }] });
    expect(unsat.violations.some((v) => v.code === 'unsat-pair')).toBe(true);
  });

  it('rejects a spec with a bad version, no features, or a bad grammar', () => {
    expect(validateSceneSpec({ specVersion: 2, brief: 'x', frame: { grammar: 'settlement' }, features: [] }).ok).toBe(false);
    expect(validateSceneSpec({ specVersion: 1, brief: 'x', frame: { grammar: 'metropolis' }, features: [{ id: 'a', kind: 'x', geom: 'region' }] }).violations.some((v) => v.code === 'bad-grammar')).toBe(true);
  });
});
