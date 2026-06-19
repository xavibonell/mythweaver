import { describe, expect, it } from 'vitest';
import type { AdventureContext } from '@mythweaver/shared';
import { buildArcBrief, FakeArcPlanner } from './arc-planner.js';

const adv: AdventureContext = {
  pitch: 'A drowned bell and a missing fisher.',
  scenes: {
    a: { title: 'Green', summary: 'The fen is quiet. Beware the tower.', exits: ['b'] },
    b: { title: 'Tower', summary: '', exits: [] },
  },
};

describe('arc-planner', () => {
  it('FakeArcPlanner derives intent + reachable exits from the authored adventure (no API)', async () => {
    const r = await new FakeArcPlanner().plan({ adventure: adv, currentSceneId: 'a', flags: {}, recentTranscript: [], party: [{ name: 'Aldric' }] });
    expect(r.costUsd).toBe(0);
    expect(r.brief.activeBeatIntent).toBe('The fen is quiet.'); // first sentence
    expect(r.brief.reachable).toEqual([{ sceneId: 'b', hook: 'toward Tower' }]);
  });

  it('buildArcBrief coerces junk, filters reachable to real exits, and drops any non-schema (imperative) field', () => {
    const exits = new Set(['bell-tower']);
    const brief = buildArcBrief(
      {
        activeBeatIntent: 'Edda is hiding something.',
        reachable: [
          { sceneId: 'bell-tower', hook: 'lights in the tower' },
          { sceneId: 'made-up-scene', hook: 'should be dropped' }, // not a real exit
          { sceneId: 'bell-tower' }, // missing hook
        ],
        bridgeNpcs: [{ name: 'Marsh-witch', role: 'buys the clapper' }, { name: '' }],
        clocks: ['the fog thickens', 123],
        notes: 'they bargained with the goblins',
        doNow: 'FORCE THE FIGHT', // not part of the schema -> must not survive
      },
      exits,
    );
    expect(brief.activeBeatIntent).toBe('Edda is hiding something.');
    expect(brief.reachable).toEqual([{ sceneId: 'bell-tower', hook: 'lights in the tower' }]);
    expect(brief.bridgeNpcs).toEqual([{ name: 'Marsh-witch', role: 'buys the clapper' }]);
    expect(brief.clocks).toEqual(['the fog thickens']);
    expect(brief.notes).toBe('they bargained with the goblins');
    expect((brief as unknown as Record<string, unknown>).doNow).toBeUndefined(); // no imperative field can leak through
  });

  it('buildArcBrief tolerates total garbage', () => {
    const b = buildArcBrief(null, new Set());
    expect(b.activeBeatIntent).toBe('');
    expect(b.reachable).toEqual([]);
    expect(b.bridgeNpcs).toBeUndefined();
  });
});
