import { describe, expect, it } from 'vitest';
import { parseTranscript, isCleanBeat, classifyMove, buildCandidates, sampleCandidates } from './exemplar-ingest.js';
import { ExemplarRetriever } from './exemplar-corpus.js';
import type { ExemplarRow } from './exemplar-ingest.js';

// A miniature fixture in the REAL transcript format (speaker-labeled, # header).
const FIXTURE = `# Some Episode | Campaign 3
# crop: opening cue; MATT -> DM

DM: So... We begin with the rocking sensation of one of the engineered cable cars as you step off and approach the tallest spire, mist burning away below you while hundreds of birds dot the canopy under the walkways and the city stretches out in tiers of stone and rope bridges toward the distant docks, the whole quarter waking around you as lanterns gutter out one by one and the morning bells begin somewhere far off, unseen, and you make your way toward the conservatory doors.
LAURA: Is the upper district quite as crowded as the lower one?
DM: Not by any means. It is the tallest and technically smallest of the spires.
MARISHA: I want to sneak around the side of the desk.
DM: Make a stealth check for me.
MARISHA: 14.
DM: (creaking) The door shifts open, and you watch as the clerk steps out, carrying a small folded envelope, and goes, "Ah, this was intended to be delivered, but could not find your abode."
TRAVIS: (laughter)
DM: The blade lunges past your shoulder and sparks off the stone as the creature wheels for another strike.
`;

describe('exemplar ingest core (Technique B)', () => {
  it('parses speaker-labeled turns and skips headers', () => {
    const turns = parseTranscript(FIXTURE);
    expect(turns[0]!.speaker).toBe('DM');
    expect(turns.filter((t) => t.speaker === 'DM')).toHaveLength(5);
    expect(turns.some((t) => t.text.startsWith('#'))).toBe(false);
  });

  it('quality-gates beats (foley + short fragments rejected)', () => {
    expect(isCleanBeat('(laughter)')).toBe(false);
    expect(isCleanBeat('Kunthea.')).toBe(false);
    expect(isCleanBeat("We'll take a break and hear from our sponsor about dice.")).toBe(false);
    expect(isCleanBeat('The door shifts open, and the clerk steps out carrying an envelope.')).toBe(true);
  });

  it('classifies the canonical move types from real-shaped lines', () => {
    expect(classifyMove('MARISHA: I want to sneak around the side.', 'Make a stealth check for me at this exact moment.')).toBe('roll-call');
    expect(classifyMove('MARISHA: 14.', 'The lock gives, and the drawer slides open with a soft complaint of old wood.')).toBe('roll-verdict');
    expect(classifyMove('LAURA: Is the upper district quite as crowded?', 'Not by any means. It is the tallest and smallest of the spires.')).toBe('short-answer');
    expect(classifyMove('', 'The clerk looks up and says, "Might I help you with something this morning?"')).toBe('npc-voice');
  });

  it('builds exchange windows with player cues, and sampling caps per type deterministically', () => {
    const cands = buildCandidates(parseTranscript(FIXTURE), 'CR3 E1');
    const stealthCall = cands.find((c) => c.text.startsWith('Make a stealth check'));
    expect(stealthCall?.moveType).toBe('roll-call');
    expect(stealthCall?.cue).toContain('MARISHA: I want to sneak');
    const verdict = cands.find((c) => c.cue.endsWith('14.'));
    expect(verdict?.moveType).toBe('roll-verdict');
    // sampling: deterministic, respects caps
    const many = Array.from({ length: 100 }, (_, i) => ({ ...cands[0]!, id: `x#${i}` }));
    expect(sampleCandidates(many, 10, 1000)).toHaveLength(10);
    expect(sampleCandidates(many, 10, 1000)).toEqual(sampleCandidates(many, 10, 1000));
  });
});

describe('ExemplarRetriever (BM25 fallback path)', () => {
  const rows: ExemplarRow[] = [
    { id: 'a', source: 'E1', moveType: 'scene-set', cue: '', text: 'The harbour opens before you, masts creaking, gulls wheeling over the fish market as the tide slaps the pilings.' },
    { id: 'b', source: 'E1', moveType: 'short-answer', cue: 'Player: asks if the harbour is busy', text: 'Not at this hour. A few dockhands, one sleepy customs clerk.' },
    { id: 'c', source: 'E2', moveType: 'short-answer', cue: 'Player: asks about the tavern', text: 'The tavern is loud tonight — sailors three deep at the bar.' },
  ];
  const r = new ExemplarRetriever(rows); // no embeddings → BM25

  it('filters by moveType and returns full rows', async () => {
    const hits = await r.retrieve('is the harbour busy with dockhands', 1, 'short-answer');
    expect(hits[0]!.id).toBe('b');
    expect(hits[0]!.moveType).toBe('short-answer');
  });

  it('excludes recently-used ids (session de-dup)', async () => {
    // A query matching BOTH short-answer rows; with "b" recently used, "c" surfaces instead.
    const hits = await r.retrieve('asks about the harbour tavern crowd', 1, 'short-answer', new Set(['b']));
    expect(hits[0]!.id).toBe('c');
  });
});
