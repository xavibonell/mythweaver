import { describe, expect, it } from 'vitest';
import { FakeLlmProvider, fakeText } from '@mythweaver/llm';
import { validateSceneSpec } from '@mythweaver/shared';
import { architectSpecs, mechanicalRepairs } from './scene-architect.js';

const GOOD_SPEC = {
  specVersion: 1,
  brief: 'a stilt shanty-town on a black reservoir',
  frame: { grammar: 'settlement', entry: { edge: 'west', pose: 'arriving' } },
  conditions: [{ profile: 'fog' }, { profile: 'dusk' }],
  features: [
    { id: 'dock1', kind: 'dock.long', geom: 'network' },
    { id: 'corpses', kind: 'decor.corpse', geom: 'point', count: 5 },
  ],
  constraints: [
    { c: 'at-edge-of', a: 'dock1', region: 'water', w: 'hard' },
    { c: 'in', a: 'corpses', region: 'water', w: 'hard' },
    { c: 'near', a: 'PARTY', b: 'dock1', w: 'story' },
  ],
};

describe('scene architect (S1 — batched L0 emission)', () => {
  it('the region literal "water" is a legal ref (corpses IN the reservoir)', () => {
    expect(validateSceneSpec(GOOD_SPEC as never).ok).toBe(true);
  });

  it('parses the batch, validates per beat, and attaches only valid specs', async () => {
    const llm = new FakeLlmProvider([
      fakeText(JSON.stringify({ specs: { 'scene:b1': GOOD_SPEC, 'scene:b2': { specVersion: 1, brief: 'x' } } })), // b2 invalid (no frame/features)
      // ONE repair round for b2 — comes back valid this time.
      fakeText(JSON.stringify({ specs: { 'scene:b2': GOOD_SPEC } })),
    ]);
    const { specs, warnings } = await architectSpecs(llm, {
      premise: 'a gothic horror',
      beats: [
        { id: 'scene:b1', title: 'A', summary: 's1' },
        { id: 'scene:b2', title: 'B', summary: 's2' },
      ],
    });
    expect(Object.keys(specs).sort()).toEqual(['scene:b1', 'scene:b2']);
    expect(warnings).toEqual([]);
  });

  it('mechanically demotes an unsat hard across+near pair instead of losing the spec', () => {
    const spec = {
      ...GOOD_SPEC,
      features: [...GOOD_SPEC.features, { id: 'pulpit', kind: 'prop.pulpit', geom: 'point' }, { id: 'bell', kind: 'prop.bell', geom: 'point' }],
      constraints: [
        ...GOOD_SPEC.constraints,
        { c: 'across', a: 'pulpit', b: 'bell', via: 'dock1', w: 'hard' },
        { c: 'near', a: 'pulpit', b: 'bell', w: 'hard' }, // the beat-3 killer
      ],
    } as never;
    const notes = mechanicalRepairs(spec);
    expect(notes[0]).toContain('demoted near(pulpit,bell)');
    expect(validateSceneSpec(spec).ok).toBe(true); // now satisfiable — the spec SURVIVES
  });

  it('drops a spec that fails repair, with a warning — the beat still plays on prose', async () => {
    const llm = new FakeLlmProvider([
      fakeText(JSON.stringify({ specs: { 'scene:b1': { specVersion: 1 } } })),
      fakeText(JSON.stringify({ specs: { 'scene:b1': { specVersion: 1, brief: 'still broken' } } })),
    ]);
    const { specs, warnings } = await architectSpecs(llm, { premise: 'p', beats: [{ id: 'scene:b1', title: 'A', summary: 's' }] });
    expect(specs['scene:b1']).toBeUndefined();
    expect(warnings[0]).toContain('scene:b1');
  });
});
