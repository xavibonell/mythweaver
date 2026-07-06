/**
 * The DM→Director handoff (Phase A): the modern realizer serves ALL kinds (the settlement gate is
 * dead), the campaign fiction reaches the programmer's brief + mood chain, and lighting follows
 * declared > mood > day.
 */
import { describe, expect, it } from 'vitest';
import { FakeLlmProvider, fakeText } from '@mythweaver/llm';
import type { EstablishScene } from '@mythweaver/shared';
import { buildModernRealizer } from './scene-lab.js';

/** A minimal valid programmer response — an enclosed interior of rooms. */
const INTERIOR_PROGRAM = JSON.stringify({
  cols: 40, rows: 26, biome: 'dungeon', lighting: 'day', grammar: 'enclosed-interior', outdoor: false,
  ops: [{ op: 'rooms', region: 'all', count: 4, wall: 'wall', floor: 'flagstone' }, { op: 'entrance', at: 'south' }],
});

function est(over: Partial<EstablishScene> = {}): EstablishScene {
  return {
    locationId: 'loc:drowned-chapel',
    brief: { setting: 'the drowned chapel beneath the reservoir', biome: 'cave', timeOfDay: 'day' },
    fixtures: [],
    npcs: [],
    ...over,
  };
}

describe('buildModernRealizer — the live DM→Director handoff', () => {
  it('no longer declines interiors/wilds (the settlements-only gate is dead)', async () => {
    const llm = new FakeLlmProvider([fakeText(INTERIOR_PROGRAM)]);
    const res = await buildModernRealizer({ llm })(est({ kind: 'interior' }), []);
    expect(res).toBeTruthy();
    expect(res!.sceneMap.grammar).toBe('enclosed-interior');
    expect(res!.provenance.engine).toBe('modern');
    expect(res!.provenance.program?.notes ?? []).toContainEqual(expect.stringContaining('kind-forced'));
  });

  it('campaign fiction (premise + beat) leads the enriched brief AND joins the mood chain', async () => {
    const llm = new FakeLlmProvider([fakeText(INTERIOR_PROGRAM)]);
    const res = await buildModernRealizer({ llm })(est(), [], {
      premise: 'a gothic horror about a debt owed to a drowned bell-founder',
      beat: { id: 'beat-1', title: 'The Rising Bell', summary: 'the bell rises at midnight, dragging the dead up its rope' },
    });
    const map = res!.sceneMap;
    // The programmer's brief carries the fiction the DM's tool call could not.
    const sent = llm.requests[0]!.messages[0]!.content as string;
    expect(sent).toContain('a gothic horror about a debt owed to a drowned bell-founder');
    expect(sent).toContain('the bell rises at midnight');
    // …and the fiction's mood words flipped the lighting (horror/midnight/dead → night).
    expect(map.lighting).toBe('night');
    // The provenance records the whole chain for the lab.
    expect(res!.provenance.enrichedBrief).toContain('drowned bell-founder');
    expect(res!.provenance.moodText).toContain('midnight');
    expect(res!.provenance.lightingReason).toBe('mood');
    expect(res!.provenance.beat).toEqual({ id: 'beat-1', title: 'The Rising Bell' });
  });

  it("the DM's mood field drives lighting when no time was declared", async () => {
    const llm = new FakeLlmProvider([fakeText(INTERIOR_PROGRAM)]);
    const res = await buildModernRealizer({ llm })(
      est({ brief: { setting: 'the chapel', biome: 'cave', timeOfDay: 'day', mood: 'fog-bound and silent' } }),
      [],
    );
    expect(res!.sceneMap.lighting).toBe('fog');
  });

  it('an EXPLICITLY declared time of day beats the mood chain (declared > mood > day)', async () => {
    const llm = new FakeLlmProvider([fakeText(INTERIOR_PROGRAM)]);
    const res = await buildModernRealizer({ llm })(
      est({
        timeOfDayExplicit: true,
        brief: { setting: 'the chapel', biome: 'cave', timeOfDay: 'dusk', mood: 'grim fog-bound midnight horror' },
      }),
      [],
    );
    expect(res!.sceneMap.lighting).toBe('dusk'); // the declaration wins over every mood keyword
    expect(res!.provenance.lightingReason).toBe('declared');
  });

  it('the coerced day default (no declaration) does NOT beat mood', async () => {
    const llm = new FakeLlmProvider([fakeText(INTERIOR_PROGRAM)]);
    // timeOfDay is 'day' from the parser default but timeOfDayExplicit is absent → mood wins.
    const res = await buildModernRealizer({ llm })(
      est({ brief: { setting: 'the chapel', biome: 'cave', timeOfDay: 'day', mood: 'moonlit night' } }),
      [],
    );
    expect(res!.sceneMap.lighting).toBe('night');
  });

  it("the DM's declared kind forces the layout family over the LLM's grammar", async () => {
    // The LLM answers with a town grammar, but the DM declared an interior.
    const llm = new FakeLlmProvider([fakeText(JSON.stringify({
      cols: 40, rows: 26, biome: 'village', lighting: 'day', grammar: 'town-square', outdoor: true,
      ops: [],
    }))]);
    const res = await buildModernRealizer({ llm })(est({ kind: 'interior' }), []);
    expect(res!.sceneMap.grammar).toBe('enclosed-interior');
  });
});
