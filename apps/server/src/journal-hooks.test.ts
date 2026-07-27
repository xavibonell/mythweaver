import { describe, expect, it } from 'vitest';
import type { GameState } from '@mythweaver/shared';
import { buildNameMatcher, clueFactKey, corroboratedClues, narratedMeets } from './journal-hooks.js';
import { STANDING_ATTR } from './interactions.js';

/**
 * The two P5 write points are LEAK GATES, not conveniences — every rule here is a leak class:
 * a card born without being named aloud, a clue whose attribute smuggles the DM's filing label,
 * an unearned subject association. Tests assert the gates, not the happy path. The three false-birth
 * lanes (shared surname / lowercase homograph / sentence-initial capital) were DEMONSTRATED by the
 * adversarial review against a looser matcher — they are permanent regressions here.
 */

const SALT = 'test-salt';
const st = (over: Partial<GameState> = {}): GameState => ({
  currentSceneId: 'scene:b1',
  flags: {},
  journal: [],
  journalSalt: SALT,
  ledger: {
    entities: {
      'npc:tessa': { id: 'npc:tessa', kind: 'npc', name: 'Tessa Reed', voice: { want: 'ZZWANTZZ' } },
      'npc:malachi': { id: 'npc:malachi', kind: 'npc', name: 'Malachi', notes: 'ZZSECRETZZ-the-villain' },
      'pc-1': { id: 'pc-1', kind: 'pc', name: 'Aldric' },
    },
    facts: [], plants: {},
  },
  ...over,
} as unknown as GameState);

/** The Reed family + a homograph — the exact cast shapes the review used to break the old matcher. */
const familySt = (): GameState => {
  const s = st();
  Object.assign((s.ledger as { entities: Record<string, unknown> }).entities, {
    'npc:garrick': { id: 'npc:garrick', kind: 'npc', name: 'Garrick Reed' },
    'npc:willow': { id: 'npc:willow', kind: 'npc', name: 'Willow' },
    'npc:rose': { id: 'npc:rose', kind: 'npc', name: 'Rose Thorn' },
  });
  return s;
};

describe('buildNameMatcher — precision first: a false match is a permanent leak, a miss self-heals', () => {
  const m = buildNameMatcher([{ name: 'Tessa Reed' }, { name: 'Garrick Reed' }, { name: 'Willow' }, { name: 'Rose Thorn' }]);
  it('multi-word full names match loosely; everything else must earn it', () => {
    expect(m('Tessa Reed', 'you spot tessa reed by the well')).toBe(true); // full name: ci
    expect(m('Tessa Reed', 'You wave at Tessa.')).toBe(true); // unique token, capitalized, mid-sentence
  });
  it('a shared surname identifies NOBODY (the Reed-family lane)', () => {
    expect(m('Garrick Reed', 'Tessa Reed waves you over.')).toBe(false);
  });
  it('a lowercase homograph is a tree, not a person (the Willow lane)', () => {
    expect(m('Willow', 'you rest beneath a willow')).toBe(false);
  });
  it('a capital that merely opens a sentence is just English (the Rose lane)', () => {
    expect(m('Rose Thorn', 'Rose petals litter the altar.')).toBe(false);
    expect(m('Rose Thorn', 'You hand the basket to Rose.')).toBe(true); // mid-sentence IS evidence
  });
});

describe('narratedMeets — narrated ⇒ revealed, and nothing else', () => {
  it('births a card the narration names, with the introducing sentence as the text', () => {
    const out = narratedMeets('The square is loud. Tessa Reed waves you over. Rain begins.', st());
    expect(out).toEqual([{ cardId: 'npc:tessa', text: 'Tessa Reed waves you over.' }]);
  });

  it('never births an un-narrated card, a PC, or a card the journal already knows', () => {
    const s = st({ journal: [{ seq: 1, turn: 1, beatId: 'scene:b1', kind: 'verdict', subjects: ['npc:tessa'], text: 'x' }] } as unknown as Partial<GameState>);
    // Tessa is known (verdict named her first), Malachi is unmentioned, Aldric is a PC.
    expect(narratedMeets('Tessa Reed nods. Aldric grins.', s)).toEqual([]);
  });

  it('introducing one member of a surname-sharing family births ONLY that member', () => {
    const out = narratedMeets('Tessa Reed waves you over.', familySt());
    expect(out.map((o) => o.cardId)).toEqual(['npc:tessa']); // Garrick Reed stays unborn
  });

  it('homographs and sentence-openers birth no one', () => {
    expect(narratedMeets('You rest beneath a willow. Rose petals litter the altar.', familySt())).toEqual([]);
  });
});

describe('corroboratedClues — the value must have been said ALOUD', () => {
  const fact = { subject: 'npc:tessa', attribute: 'seen-at-night', value: 'she was seen by the bell tower after dark' };

  it('passes a fact whose value appears verbatim, carrying value only — never the attribute', () => {
    const out = corroboratedClues('Hobb leans in: she was seen by the bell tower after dark, he mutters.', [
      { ...fact, attribute: 'ZZATTRZZ-secretly-a-doppelganger' },
    ], st());
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('Learned: she was seen by the bell tower after dark');
    expect(JSON.stringify(out)).not.toContain('ZZATTRZZ'); // the filing label was never heard
  });

  it('drops un-narrated, short, and standing facts', () => {
    const s = st();
    expect(corroboratedClues('nothing relevant said', [fact], s)).toEqual([]); // not narrated
    expect(corroboratedClues('yes indeed', [{ ...fact, value: 'yes indeed' }], s)).toEqual([]); // < 12 chars
    expect(corroboratedClues('she was seen by the bell tower after dark', [{ ...fact, attribute: STANDING_ATTR }], s)).toEqual([]);
  });

  it('attaches the subject card ONLY when the players know them (met before, or named in the same breath)', () => {
    const s = st();
    const secretFact = { subject: 'npc:malachi', attribute: 'habit', value: 'someone avoids the chapel every dusk' };
    // Value narrated, but Malachi never named and never met: the clue stands ALONE.
    expect(corroboratedClues('You hear that someone avoids the chapel every dusk.', [secretFact], s)[0]!.subjects).toEqual([]);
    // Named in the same narration → the association was earned at the table.
    expect(corroboratedClues('They whisper of Malachi — someone avoids the chapel every dusk.', [secretFact], s)[0]!.subjects).toEqual(['npc:malachi']);
  });

  it('never writes the same fact twice — across the journal or within one batch', () => {
    const s = st({ journal: [{ seq: 1, turn: 1, beatId: 'scene:b1', kind: 'clue', subjects: [], text: 'x', data: { factKey: clueFactKey('npc:tessa', 'seen-at-night', SALT) } }] } as unknown as Partial<GameState>);
    expect(corroboratedClues('she was seen by the bell tower after dark', [fact, fact], s)).toEqual([]);
    expect(corroboratedClues('she was seen by the bell tower after dark', [fact, fact], st())).toHaveLength(1);
  });

  it('the shipped factKey is a SALTED hash — unguessable without the salt, stable within a session', () => {
    expect(clueFactKey('npc:malachi', 'ZZATTRZZ-secretly-a-doppelganger', SALT)).toMatch(/^fk_[0-9a-f]+$/);
    expect(clueFactKey('a', 'b', 'salt-1')).not.toBe(clueFactKey('a', 'b', 'salt-2')); // no offline oracle
    const s = st({ journalSalt: undefined } as unknown as Partial<GameState>);
    corroboratedClues('she was seen by the bell tower after dark', [fact], s);
    expect(s.journalSalt).toBeTruthy(); // minted on first use, persisted with the state for reload-stable dedup
  });
});

describe('tokenEvidence quote guard — a name opening DIALOGUE is as ambiguous as one opening a sentence', () => {
  it('quoted-initial capitals are not evidence; the same name mid-quote is', () => {
    const m = buildNameMatcher([{ name: 'Rose Thorn' }]);
    expect(m('Rose Thorn', 'She sighs. “Rose petals litter the altar,” she says.')).toBe(false);
    expect(m('Rose Thorn', '“I warned Rose about this,” she says.')).toBe(true);
  });
});
