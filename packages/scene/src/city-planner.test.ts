import { describe, expect, it } from 'vitest';
import { FakeLlmProvider, fakeText } from '@mythweaver/llm';
import { validateSceneMap } from '@mythweaver/shared';
import { buildCityScene } from './city.js';
import { LlmCityPlanner, normalizeDistricts } from './city-planner.js';

describe('city planner (V3 macro tier)', () => {
  it('normalizes a well-formed plan, folding builds into the setting', () => {
    const specs = normalizeDistricts({
      districts: [
        { setting: 'a bustling market square', builds: ['tavern', 'shop'], npcs: [{ name: 'Marta', look: 'a merchant woman' }] },
        { setting: 'a temple precinct', builds: ['temple', 'shrine'], npcs: [] },
      ],
    });
    expect(specs).toHaveLength(2);
    expect(specs[0]!.builds).toEqual(['tavern', 'shop']);
    expect(specs[0]!.setting).toContain('market square');
    expect(specs[0]!.setting).toContain('tavern, shop'); // settlement keyword guaranteed
    expect(specs[0]!.npcs).toEqual([{ name: 'Marta', look: 'a merchant woman' }]);
  });

  it('strips water words from settings (no city water yet)', () => {
    const specs = normalizeDistricts({ districts: [{ setting: 'a busy riverside dock quarter by the harbour', builds: ['warehouse', 'shop'] }] });
    expect(specs[0]!.setting).not.toMatch(/river|dock|harbou?r|water|shore|quay/i);
  });

  it('maps unknown build words to a carvable building (house)', () => {
    const specs = normalizeDistricts({ districts: [{ setting: 'a slum', builds: ['warehouse', 'fountain', 'statue'] }] });
    // none of those are carvable building words → all fall back to house
    expect(specs[0]!.builds.every((b) => b === 'house')).toBe(true);
  });

  it('falls back to a usable default on garbage output', () => {
    expect(normalizeDistricts(null).length).toBeGreaterThan(0);
    expect(normalizeDistricts({ districts: 'nope' }).length).toBeGreaterThan(0);
    expect(normalizeDistricts({ districts: [{}] })[0]!.builds.length).toBeGreaterThan(0);
  });

  it('clamps district count to max', () => {
    const many = { districts: Array.from({ length: 20 }, () => ({ setting: 'a quarter', builds: ['house'] })) };
    expect(normalizeDistricts(many, 6)).toHaveLength(6);
  });

  it('plans from an LLM response (parsed from text) without network', async () => {
    const json = JSON.stringify({ districts: [{ setting: 'a market square', builds: ['tavern', 'shop'], npcs: [{ name: 'M', look: 'a guard' }] }, { setting: 'a forge row', builds: ['smithy', 'workshop'] }] });
    const planner = new LlmCityPlanner(new FakeLlmProvider([fakeText('Here is the plan: ' + json)]));
    const specs = await planner.plan('a small craft town');
    expect(specs).toHaveLength(2);
    expect(specs[1]!.builds).toEqual(['smithy', 'workshop']);
  });

  it('end-to-end: planned districts stitch into a valid city SceneMap', async () => {
    const json = JSON.stringify({
      districts: [
        { setting: 'a market square', builds: ['tavern', 'shop'], npcs: [{ name: 'M', look: 'a merchant' }] },
        { setting: 'a temple precinct', builds: ['temple', 'house'] },
        { setting: 'a forge row', builds: ['smithy', 'workshop'] },
      ],
    });
    const planner = new LlmCityPlanner(new FakeLlmProvider([fakeText(json)]));
    const districts = await planner.plan('a holy craft town');
    const m = await buildCityScene({ locationId: 'loc:planned-city', districts });
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    expect(m.grammar).toBe('town-square');
  });
});
