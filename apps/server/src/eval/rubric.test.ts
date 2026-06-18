import { describe, expect, it } from 'vitest';
import { RUBRIC_DIMENSIONS, buildJudgePrompt, parseJudgeScores } from './rubric.js';

const goodJson = JSON.stringify({
  rulesFidelity: 4,
  sourceFaithfulness: 5,
  style: 3,
  pacing: 4,
  coherence: 5,
  agency: 2,
  rationale: 'solid',
});

describe('parseJudgeScores', () => {
  it('parses a clean JSON object', () => {
    const s = parseJudgeScores(goodJson);
    expect(s.rulesFidelity).toBe(4);
    expect(s.agency).toBe(2);
  });

  it('tolerates surrounding prose / code fences', () => {
    const s = parseJudgeScores('Here are the scores:\n```json\n' + goodJson + '\n```\nDone.');
    expect(s.sourceFaithfulness).toBe(5);
  });

  it('clamps out-of-range and rounds', () => {
    const s = parseJudgeScores(JSON.stringify({ ...JSON.parse(goodJson), style: 9, pacing: -3, coherence: 4.4 }));
    expect(s.style).toBe(5);
    expect(s.pacing).toBe(0);
    expect(s.coherence).toBe(4);
  });

  it('throws when a dimension is missing', () => {
    const partial = JSON.parse(goodJson);
    delete partial.agency;
    expect(() => parseJudgeScores(JSON.stringify(partial))).toThrow();
  });

  it('throws on no JSON at all', () => {
    expect(() => parseJudgeScores('no json here')).toThrow();
  });
});

describe('buildJudgePrompt', () => {
  it('includes every rubric dimension key and the narration', () => {
    const p = buildJudgePrompt({ playerInput: 'I look around', narration: 'A foggy green.', toolCalls: ['getState'] });
    for (const d of RUBRIC_DIMENSIONS) expect(p).toContain(d.key);
    expect(p).toContain('A foggy green.');
    expect(p).toContain('getState');
  });
});
