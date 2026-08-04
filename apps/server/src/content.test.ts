import { describe, expect, it } from 'vitest';
import { resolveParty } from './content.js';

describe('resolveParty', () => {
  it('sets an authored backstory on the resolved sheet, and omits it when absent', () => {
    const party = resolveParty([
      { role: 'fighter', name: 'Aldric', backstory: 'a disgraced knight' },
      { role: 'wizard', name: 'Elara' },
    ]);
    expect(party).toHaveLength(2);
    expect(party[0]!.name).toBe('Aldric');
    expect(party[0]!.backstory).toBe('a disgraced knight');
    expect(party[1]!.name).toBe('Elara');
    expect(party[1]!.backstory).toBeUndefined();
  });

  it('gives each pick a unique id and drops unknown roles', () => {
    const party = resolveParty([{ role: 'fighter' }, { role: 'not-a-role' }, { role: 'rogue' }]);
    expect(party.map((p) => p.className)).toEqual(['Fighter', 'Rogue']);
    expect(new Set(party.map((p) => p.id)).size).toBe(2); // unique ids
  });
});
