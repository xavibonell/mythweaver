import { describe, expect, it } from 'vitest';
import { validateSceneMap } from '@mythweaver/shared';
import { realizeCityBsp, realizeCityMesh, type CityContents } from './city-realizer.js';

// The wire-in contract: the DM describes WHAT the city contains ("a church and a blacksmith, a grand
// plaza, characters A/B/C") and the engine GUARANTEES it — requested buildings claim wards, named
// characters stand on the plaza. Checked by the buildings' defining interiors (a temple realizes an
// altar, a smithy a forge/anvil, a tavern a bar run), since ward types aren't stored on the SceneMap.

const ROSTER: CityContents = {
  buildings: ['temple', 'smithy', 'tavern'],
  npcs: [{ name: 'Aldric' }, { name: 'Bella' }, { name: 'Corin' }],
  plaza: 'grand',
};

describe('city contents — the DM roster is guaranteed (orthogonal engine)', () => {
  it('realizes every requested building type + every named character, across seeds', () => {
    for (const seed of [1, 5, 9]) {
      const m = realizeCityBsp(seed, { nPatches: 15, contents: ROSTER });
      const tags = new Set(m.objects.map((o) => o.tag));
      expect(tags.has('altar'), `seed ${seed}: temple → altar`).toBe(true);
      expect(tags.has('forge') || tags.has('anvil'), `seed ${seed}: smithy → forge/anvil`).toBe(true);
      expect(tags.has('bar_counter'), `seed ${seed}: tavern → bar run`).toBe(true);
      for (const name of ['Aldric', 'Bella', 'Corin']) {
        const npc = m.objects.find((o) => o.kind === 'actor' && o.name === name);
        expect(npc, `seed ${seed}: named npc ${name}`).toBeTruthy();
        expect(m.walkable[npc!.row]![npc!.col], `seed ${seed}: ${name} stands on walkable ground`).toBe(true);
      }
      expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    }
  });

  it('gives the named cast stable ids derived from their names', () => {
    const m = realizeCityBsp(5, { nPatches: 15, contents: ROSTER });
    for (const id of ['npc:aldric', 'npc:bella', 'npc:corin']) expect(m.objects.some((o) => o.id === id), id).toBe(true);
  });

  it('is deterministic (same roster + seed → byte-identical map)', () => {
    const a = JSON.stringify(realizeCityBsp(7, { nPatches: 15, contents: ROSTER }));
    const b = JSON.stringify(realizeCityBsp(7, { nPatches: 15, contents: ROSTER }));
    expect(a).toBe(b);
  });

  it('the organic engine honours the same roster', () => {
    const m = realizeCityMesh(3, { nPatches: 15, contents: ROSTER });
    const tags = new Set(m.objects.map((o) => o.tag));
    expect(tags.has('altar')).toBe(true);
    expect(m.objects.some((o) => o.name === 'Aldric')).toBe(true);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
  });

  it('no roster → the default signature city, unchanged behaviour', () => {
    const a = JSON.stringify(realizeCityBsp(7, { nPatches: 15 }));
    const b = JSON.stringify(realizeCityBsp(7, { nPatches: 15, contents: undefined }));
    expect(a).toBe(b);
  });
});
