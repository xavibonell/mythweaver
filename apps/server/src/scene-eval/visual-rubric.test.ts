import { describe, expect, it } from 'vitest';
import { buildVisualJudgePrompt, JUDGE_LENSES, NOT_DEFECTS, parseVisualVerdict, VISUAL_RUBRIC } from './visual-rubric.js';

describe('visual rubric — judge prompt', () => {
  it('names every dimension and the intentional NOT-A-DEFECT features (calibration)', () => {
    const p = buildVisualJudgePrompt({ subject: 'a test render', tilePx: 16 }, JUDGE_LENSES[0]!);
    for (const d of VISUAL_RUBRIC) expect(p).toContain(d.key);
    // The calibration knob must reach the prompt so the judge stops dinging courtyards/gardens.
    expect(p.toLowerCase()).toContain('courtyard');
    expect(p).toContain(NOT_DEFECTS[0]!);
    expect(p).toContain(JUDGE_LENSES[0]!.focus);
  });
});

describe('visual rubric — parseVisualVerdict', () => {
  const goodScores = VISUAL_RUBRIC.map((d) => `"${d.key}": 3`).join(', ');

  it('parses scores + canonical-localised defects', () => {
    const v = parseVisualVerdict(`{${goodScores}, "defects": [{"severity":"critical","category":"openingSanity","unit":"#2","region":"s","detail":"hole in wall"}], "rationale":"ok"}`);
    expect(v.scores.openingSanity).toBe(3);
    expect(v.defects).toHaveLength(1);
    expect(v.defects[0]).toMatchObject({ severity: 'critical', category: 'openingSanity', unit: '#2', region: 's', detail: 'hole in wall' });
    expect(v.rationale).toBe('ok');
  });

  it('clamps out-of-range scores into 0..5', () => {
    const scores = VISUAL_RUBRIC.map((d) => `"${d.key}": ${d.key === 'wallIntegrity' ? 9 : -2}`).join(', ');
    const v = parseVisualVerdict(`{${scores}, "defects": []}`);
    expect(v.scores.wallIntegrity).toBe(5);
    expect(v.scores.openingSanity).toBe(0);
  });

  it('tolerates legacy keys (where/description) and bad enums, dropping empty defects', () => {
    const v = parseVisualVerdict(
      `prose… {${goodScores}, "defects": [` +
        `{"severity":"oops","category":"nonsense","region":"middle","where":"#4 top","description":"loose chair"},` +
        `{"category":"wallIntegrity","unit":"#1","region":"nw","detail":""}` + // empty detail → dropped
        `]} trailing`,
    );
    expect(v.defects).toHaveLength(1);
    expect(v.defects[0]).toMatchObject({ severity: 'minor', category: 'overallFidelity', unit: '#4 top', region: 'whole', detail: 'loose chair' });
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseVisualVerdict('no json here')).toThrow();
  });
});
