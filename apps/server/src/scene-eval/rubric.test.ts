import { describe, expect, it } from 'vitest';
import { buildSceneJudgePrompt, parseSceneScores, SCENE_RUBRIC } from './rubric.js';
import { checkInvariants } from './runner.js';
import { FakeSceneComposer } from '@mythweaver/scene';
import { buildSceneMap } from '@mythweaver/scene';
import type { EstablishScene, PartyMemberRef } from '@mythweaver/shared';

describe('scene rubric', () => {
  it('parses + clamps judge scores for every dimension', () => {
    const raw = `{"spatialSense": 4, "legibility": 7, "briefCoherence": 3, "completeness": -1, "rationale": "ok"}`;
    const s = parseSceneScores(raw);
    expect(s.spatialSense).toBe(4);
    expect(s.legibility).toBe(5); // clamped to 0..5
    expect(s.completeness).toBe(0);
    for (const d of SCENE_RUBRIC) expect(typeof s[d.key]).toBe('number');
  });

  it('throws on missing dimensions', () => {
    expect(() => parseSceneScores('{"spatialSense": 3}')).toThrow();
    expect(() => parseSceneScores('not json')).toThrow();
  });

  it('embeds the brief + digest in the judge prompt', () => {
    const p = buildSceneJudgePrompt({ brief: 'a seaside village', digest: 'Grammar: town-square' });
    expect(p).toContain('a seaside village');
    expect(p).toContain('town-square');
    expect(p).toContain('spatialSense');
  });
});

describe('scene invariants (checkInvariants)', () => {
  // Build a real town-square SceneMap deterministically (no LLM) to exercise the gate.
  async function townMap() {
    const est: EstablishScene = {
      locationId: 'loc:harbor',
      brief: { setting: 'a seaside village square', biome: 'village', timeOfDay: 'day' },
      fixtures: [
        { id: 'prop:fountain', kind: 'prop', tag: 'fountain' },
        { id: 'bldg:h1', kind: 'fixture', tag: 'house_red' },
      ],
      npcs: [{ id: 'npc:elder', name: 'Elder', look: 'an old villager', visible: true }],
    };
    const party: PartyMemberRef[] = [{ id: 'pc:aldric', spriteTag: 'knight', name: 'Aldric' }];
    const comp = await new FakeSceneComposer().compose({ establish: est, party, seed: 9 });
    return { brief: est.brief.setting, establish: est, composition: comp, sceneMap: buildSceneMap(comp), narration: '', model: 'fake' };
  }

  it('passes a well-formed town-square (centred fountain, valid map)', async () => {
    const r = await townMap();
    const res = checkInvariants(r, { grammar: 'town-square', mustRenderTags: ['fountain'], fountainCentered: true });
    expect(res).toEqual({ ok: true, failures: [] });
  });

  it('flags a missing required tag', async () => {
    const r = await townMap();
    const res = checkInvariants(r, { mustRenderTags: ['dragon'] });
    expect(res.ok).toBe(false);
    expect(res.failures.join(' ')).toContain('dragon');
  });
});
