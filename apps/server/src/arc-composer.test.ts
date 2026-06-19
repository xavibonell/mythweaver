import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LlmProvider, LlmRequest, LlmResponse } from '@mythweaver/llm';
import { FakeArcComposer, LlmArcComposer, buildGeneratedArc, type ArcSeed } from './arc-composer.js';

const seed: ArcSeed = { theme: 'a haunted lighthouse', tone: 'horror', lengthBeats: 4, party: [{ name: 'Aldric' }] };
// StampCtx is internal; this matches its shape (used to drive buildGeneratedArc directly).
const ctx0 = { model: 'test', promptText: 'P', usage: { inputTokens: 1, outputTokens: 2 }, now: () => 0, fallback: false };

/** Minimal provider stub returning a fixed completion (no API). */
function stub(text: string): LlmProvider {
  return {
    async complete(_req: LlmRequest): Promise<LlmResponse> {
      return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 }, model: 'claude-haiku-4-5-20251001' as LlmResponse['model'], stopReason: 'end' };
    },
  };
}

describe('arc-composer', () => {
  describe('FakeArcComposer (deterministic $0 path — tests/eval/fallback)', () => {
    it('produces an engine-safe arc: minted ids, resolvable exits, no encounters, spine ⊆ beats', async () => {
      const { arc, costUsd } = await new FakeArcComposer().compose(seed, { now: () => 0 });
      expect(costUsd).toBe(0);
      expect(arc.startSceneId).toBe('scene:b1');
      const ids = Object.keys(arc.adventure.scenes);
      expect(ids).toEqual(['scene:b1', 'scene:b2', 'scene:b3', 'scene:b4']);
      for (const s of Object.values(arc.adventure.scenes)) for (const e of s.exits ?? []) expect(ids).toContain(e);
      expect(arc.encounters).toEqual([]);
      for (const sp of arc.blueprint.spine) if (sp.sceneId) expect(ids).toContain(sp.sceneId);
      expect(arc.genMeta.model).toBe('fake');
      expect(arc.genMeta.fallback).toBe(false);
    });

    it('is byte-stable for the same seed (the deterministic eval gate)', async () => {
      const a = await new FakeArcComposer().compose(seed, { now: () => 0 });
      const b = await new FakeArcComposer().compose(seed, { now: () => 0 });
      expect(a.arc.genMeta.seedHash).toBe(b.arc.genMeta.seedHash);
      expect(JSON.stringify(a.arc)).toBe(JSON.stringify(b.arc));
    });

    it('a different theme yields a different arc + different seedHash (catches a seed-ignoring generator)', async () => {
      const a = await new FakeArcComposer().compose(seed, { now: () => 0 });
      const b = await new FakeArcComposer().compose({ ...seed, theme: 'a sunken cathedral' }, { now: () => 0 });
      expect(a.arc.genMeta.seedHash).not.toBe(b.arc.genMeta.seedHash);
      expect(JSON.stringify(a.arc.adventure)).not.toBe(JSON.stringify(b.arc.adventure));
    });

    it('clamps length to 3-8 beats', async () => {
      const lo = await new FakeArcComposer().compose({ ...seed, lengthBeats: 1 }, { now: () => 0 });
      const hi = await new FakeArcComposer().compose({ ...seed, lengthBeats: 99 }, { now: () => 0 });
      expect(Object.keys(lo.arc.adventure.scenes).length).toBe(3);
      expect(Object.keys(hi.arc.adventure.scenes).length).toBe(8);
    });
  });

  describe('buildGeneratedArc coercion (the lone engine-safety chokepoint)', () => {
    it('mints ids and drops self / out-of-range / forged / junk exits', () => {
      const raw = {
        premise: 'p', centralProblem: 'c', intendedEnding: 'e', opening: 'o',
        beats: [
          { title: 'A', summary: 's', exits: [2, 1, 99, 'x'] }, // 1 is self → drop; 99 forged → drop; 'x' junk → drop
          { title: 'B', summary: 's', exits: [3] },
          { title: 'C', summary: 's', exits: [] },
        ],
      };
      const arc = buildGeneratedArc(raw, seed, ctx0)!;
      expect(arc).not.toBeNull();
      expect(Object.keys(arc.adventure.scenes)).toEqual(['scene:b1', 'scene:b2', 'scene:b3']);
      expect(arc.adventure.scenes['scene:b1']!.exits).toEqual(['scene:b2']);
      expect(arc.encounters).toEqual([]);
    });

    it('guarantees reachability — an orphan beat gets linked from its predecessor', () => {
      const raw = { premise: 'p', intendedEnding: 'e', beats: [{ title: 'A', summary: 's', exits: [] }, { title: 'B', summary: 's', exits: [] }] };
      const arc = buildGeneratedArc(raw, seed, ctx0)!;
      expect(arc.adventure.scenes['scene:b1']!.exits).toContain('scene:b2');
    });

    it('remaps spine "beat" index → sceneId and drops an out-of-range beat ref', () => {
      const raw = {
        premise: 'p', intendedEnding: 'e',
        beats: [{ title: 'A', summary: 's', exits: [2] }, { title: 'B', summary: 's', exits: [] }],
        spine: [{ milestone: 'M1', beat: 1, intent: 'i' }, { milestone: 'M2', beat: 9, intent: 'i2' }],
      };
      const arc = buildGeneratedArc(raw, seed, ctx0)!;
      expect(arc.blueprint.spine).toEqual([
        { milestone: 'M1', intent: 'i', sceneId: 'scene:b1' },
        { milestone: 'M2', intent: 'i2' },
      ]);
    });

    it('derives a spine from the beats when the model gives none', () => {
      const raw = { premise: 'p', intendedEnding: 'e', beats: [{ title: 'A', summary: 's', exits: [2], intent: 'x' }, { title: 'B', summary: 's', exits: [] }] };
      const arc = buildGeneratedArc(raw, seed, ctx0)!;
      expect(arc.blueprint.spine.length).toBe(2);
      expect(arc.blueprint.spine[0]).toEqual({ milestone: 'A', sceneId: 'scene:b1', intent: 'x' });
    });

    it('returns null when there are no usable beats (so the caller can fall back)', () => {
      expect(buildGeneratedArc({ premise: 'p', beats: [] }, seed, ctx0)).toBeNull();
      expect(buildGeneratedArc(null, seed, ctx0)).toBeNull();
    });

    it('stamps provenance (seedHash, prompt hash, timestamp, tokens)', () => {
      const arc = buildGeneratedArc({ premise: 'p', intendedEnding: 'e', beats: [{ title: 'A', summary: 's', exits: [] }] }, seed, { ...ctx0, now: () => 123 })!;
      expect(arc.genMeta.timestampMs).toBe(123);
      expect(arc.genMeta.composerPromptHash).toMatch(/^[0-9a-f]{12}$/);
      expect(arc.genMeta.seedHash).toMatch(/^[0-9a-f]{12}$/);
      expect(arc.genMeta.inputTokens).toBe(1);
    });
  });

  describe('LlmArcComposer', () => {
    it('coerces valid model JSON into an engine-safe arc (fallback=false)', async () => {
      const good = JSON.stringify({
        premise: 'A drowned town', centralProblem: 'c', intendedEnding: 'e', opening: 'o',
        beats: [{ title: 'Arrival', summary: 's', exits: [2] }, { title: 'Finale', summary: 's', exits: [] }],
        spine: [{ milestone: 'M', beat: 1, intent: 'i' }],
      });
      const { arc } = await new LlmArcComposer(stub(`here you go ${good}`)).compose(seed, { now: () => 0 });
      expect(arc.genMeta.fallback).toBe(false);
      expect(arc.startSceneId).toBe('scene:b1');
      expect(arc.adventure.scenes['scene:b1']!.title).toBe('Arrival');
    });

    it('falls back to the deterministic arc on unusable output, stamping the REAL prompt hash + fallback flag', async () => {
      const composer = new LlmArcComposer(stub('no json at all'), { composerSystem: () => 'CUSTOM PROMPT' });
      const { arc, costUsd } = await composer.compose(seed, { now: () => 0 });
      expect(arc.genMeta.fallback).toBe(true);
      expect(costUsd).toBe(0);
      expect(arc.genMeta.composerPromptHash).toBe(createHash('sha1').update('CUSTOM PROMPT').digest('hex').slice(0, 12));
    });
  });
});
