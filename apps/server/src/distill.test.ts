import { describe, it, expect } from 'vitest';
import { FakeLlmProvider, fakeText } from '@mythweaver/llm';
import { reconcile, DISTILL_MARKERS } from './distill.js';

// A tiny playbook with canon (## STYLE) + an existing distilled region.
const PLAYBOOK = [
  '## STYLE',
  '- be vivid and economical',
  '',
  DISTILL_MARKERS.guide.begin,
  '## PRINCIPLES (distilled from a guide)',
  '- Keep the session moving.',
  DISTILL_MARKERS.guide.end,
].join('\n');

const NEW_BLOCK = '## PRINCIPLES\n- Telegraph danger early.\n- Reward bold play.';

describe('reconcile — cumulative merge plan (no API; FakeLlm)', () => {
  it('parses a clean JSON plan into keep / conflicts / notes', async () => {
    const llm = new FakeLlmProvider([
      fakeText(JSON.stringify({
        keep: ['Telegraph danger early.', 'Reward bold play.'],
        conflicts: [{ add: 'Pace scenes briskly.', remove: 'Keep the session moving.', why: 'same topic, reworded' }],
        notes: ['overlaps canon: be vivid'],
      })),
    ]);
    const plan = await reconcile(llm, 'guide', NEW_BLOCK, PLAYBOOK);
    expect(plan.keep).toEqual(['Telegraph danger early.', 'Reward bold play.']);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ add: 'Pace scenes briskly.', remove: 'Keep the session moving.' });
    expect(plan.notes).toContain('overlaps canon: be vivid');
  });

  it('strips a fenced ```json code block before parsing', async () => {
    const llm = new FakeLlmProvider([fakeText('```json\n' + JSON.stringify({ keep: ['A'], conflicts: [], notes: [] }) + '\n```')]);
    const plan = await reconcile(llm, 'guide', NEW_BLOCK, PLAYBOOK);
    expect(plan.keep).toEqual(['A']);
  });

  it('tripwire: drops a bullet that encodes a mechanical number into notes', async () => {
    const llm = new FakeLlmProvider([
      fakeText(JSON.stringify({ keep: ['Set the DC 15 for hard climbs', 'Reward bold play.'], conflicts: [], notes: [] })),
    ]);
    const plan = await reconcile(llm, 'guide', NEW_BLOCK, PLAYBOOK);
    expect(plan.keep).toEqual(['Reward bold play.']);
    expect(plan.notes.join(' ')).toMatch(/looks mechanical/i);
  });

  it('falls back to a pure cumulative append when the LLM output is not JSON', async () => {
    const llm = new FakeLlmProvider([fakeText('Sorry, I cannot do that.')]);
    const plan = await reconcile(llm, 'guide', NEW_BLOCK, PLAYBOOK);
    expect(plan.keep).toEqual(['Telegraph danger early.', 'Reward bold play.']);
    expect(plan.conflicts).toEqual([]);
  });

  it('falls back when the LLM call throws (degrade, never break Apply)', async () => {
    const llm = new FakeLlmProvider([]); // complete() throws — no scripted response
    const plan = await reconcile(llm, 'guide', NEW_BLOCK, PLAYBOOK);
    expect(plan.keep).toEqual(['Telegraph danger early.', 'Reward bold play.']);
  });
});
