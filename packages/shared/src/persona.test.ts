import { describe, expect, it } from 'vitest';
import { personaLine, personaOf, profileOf, reactTo, type Persona } from './persona.js';

describe('profileOf — Tier-1 derived persona (role/tag/id, no storage)', () => {
  it('reads a town-guard family as authority (brave)', () => {
    for (const s of [
      { id: 'npc:aldric', tag: 'knight', name: 'Aldric' },
      { id: 'npc:watch-captain', tag: 'guard', name: 'Roderic' },
      { id: 'npc:sentry', tag: 'soldier' },
      { id: 'npc:constable-vey', name: 'Vey' }, // signal in the id, not the tag
    ]) {
      expect(profileOf(s).archetype).toBe('authority');
      expect(profileOf(s).temper).toBe('brave');
    }
  });

  it('reads tradespeople and post-keepers as keeper (territorial)', () => {
    for (const s of [{ id: 'npc:storehouse-keeper' }, { id: 'npc:hobb', tag: 'blacksmith', name: 'Hobb' }, { id: 'npc:mira', tag: 'merchant', name: 'Mira' }, { id: 'npc:barkeep' }]) {
      expect(profileOf(s).archetype).toBe('keeper');
      expect(profileOf(s).temper).toBe('territorial');
    }
  });

  it('reads clergy/shrine roles as cleric (steady)', () => {
    for (const s of [{ id: 'npc:brother-cael', tag: 'monk' }, { id: 'npc:priestess', name: 'Sela' }, { id: 'npc:shrine-warden' /* warden→authority? */ }]) {
      // the shrine-warden is intentionally ambiguous — 'warden' is an authority word and wins first (documented order)
      const a = profileOf(s).archetype;
      expect(a === 'cleric' || a === 'authority').toBe(true);
    }
    expect(profileOf({ id: 'npc:brother-cael', tag: 'monk' }).archetype).toBe('cleric');
    expect(profileOf({ id: 'npc:brother-cael', tag: 'monk' }).temper).toBe('steady');
  });

  it('reads animals as beast (timid) and hostiles as monster/beast (feral)', () => {
    expect(profileOf({ id: 'npc:dog', tag: 'hound', name: 'Scrap' }).archetype).toBe('beast');
    expect(profileOf({ id: 'npc:dog', tag: 'hound' }).temper).toBe('timid');
    expect(profileOf({ id: 'mob:bandit-1', role: 'mob', tag: 'bandit' }).archetype).toBe('monster');
    expect(profileOf({ id: 'mob:bandit-1', role: 'mob', tag: 'bandit' }).temper).toBe('feral');
    expect(profileOf({ id: 'mob:wolf-2', role: 'mob', tag: 'wolf' }).archetype).toBe('beast'); // a mob that is an animal
    expect(profileOf({ id: 'mob:wolf-2', role: 'mob', tag: 'wolf' }).temper).toBe('feral');
  });

  it('falls back to commoner and marks every derived persona', () => {
    const p = profileOf({ id: 'npc:tessa', name: 'Tessa Reed', tag: 'villager' });
    expect(p.archetype).toBe('commoner');
    expect(p.derived).toBe(true);
  });

  it("honours the scene generator's building-anchor convention: '<building>-keeper' NPCs are keepers", () => {
    // These id shapes are exactly what the oakhollow/drowned-bell fixtures produce for building
    // occupants — rooted-to-a-building reads as territorial even when the tag is a plain villager.
    for (const id of ['npc:loc-oakhollow-green-b3-keeper', 'npc:house-2-keeper', 'npc:boathouse-keeper', 'npc:loc-oakhollow-green-b1-keeper']) {
      expect(profileOf({ id, tag: 'villager' }).archetype).toBe('keeper');
    }
    // But a plain street villager (no -keeper anchor) stays a commoner — the convention is the SUFFIX,
    // not the tag.
    expect(profileOf({ id: 'npc:loc-oakhollow-green-villager-1', tag: 'villager' }).archetype).toBe('commoner');
  });
});

describe('profileOf — commoner temper is a stable id-hash split (variety, not uniformity)', () => {
  it('an anonymous extra is timid; a named commoner gets a temper from its id', () => {
    expect(profileOf({ id: 'npc:villager-7', tag: 'villager' }).temper).toBe('timid'); // no name → timid
    expect(['timid', 'steady', 'bold']).toContain(profileOf({ id: 'npc:tessa', name: 'Tessa' }).temper);
  });

  it('depends only on the id — the same id maps the same way regardless of tag/name spelling', () => {
    const a = profileOf({ id: 'npc:tessa', name: 'Tessa' }).temper;
    const b = profileOf({ id: 'npc:tessa', name: 'Tessa Reed', tag: 'villager' }).temper;
    expect(a).toBe(b);
  });

  it('a crowd is not uniform — distinct ids spread across more than one temper', () => {
    const ids = ['npc:a', 'npc:b', 'npc:c', 'npc:d', 'npc:e', 'npc:f', 'npc:g', 'npc:h', 'npc:i', 'npc:j', 'npc:k', 'npc:l'];
    const tempers = new Set(ids.map((id) => profileOf({ id, name: id }).temper));
    expect(tempers.size).toBeGreaterThanOrEqual(2);
  });
});

describe('personaOf — Tier-2 authored seed overrides derivation field-by-field', () => {
  it('with no seed, returns the derivation verbatim', () => {
    const s = { id: 'npc:tessa', name: 'Tessa', tag: 'villager' };
    expect(personaOf(s)).toEqual(profileOf(s));
  });

  it('an authored allegiance/stake enriches a derived archetype (still counts as derived identity)', () => {
    const p = personaOf({ id: 'npc:tessa', name: 'Tessa', tag: 'villager' }, { allegiance: 'the town', stake: 'her market stall' });
    expect(p.archetype).toBe('commoner'); // archetype still derived
    expect(p.allegiance).toBe('the town');
    expect(p.stake).toBe('her market stall');
    expect(p.derived).toBe(true); // neither identity field was authored
  });

  it('an authored archetype/temper overrides the derivation and drops the derived flag', () => {
    const p = personaOf({ id: 'npc:milla', name: 'Milla', tag: 'villager' }, { archetype: 'authority', temper: 'brave' });
    expect(p.archetype).toBe('authority'); // the DM knows she is secretly the sheriff
    expect(p.temper).toBe('brave');
    expect(p.derived).toBeUndefined();
  });
});

describe('reactTo — (persona, perception grade) → a coordinate-free reaction intent', () => {
  const commoner = (temper: Persona['temper']): Persona => ({ archetype: 'commoner', temper });

  it('an oblivious witness does nothing; a walled-off alerted one emerges next beat', () => {
    expect(reactTo(commoner('timid'), 'oblivious')).toEqual({ verb: 'none', toward: 'none' });
    const em = reactTo(commoner('steady'), 'alerted');
    expect(em.verb).toBe('emerge');
    expect(em.goal).toBe('investigate');
  });

  it('authority closes on the attacker; a monster does too', () => {
    expect(reactTo({ archetype: 'authority', temper: 'brave' }, 'saw')).toMatchObject({ verb: 'confront', toward: 'attacker', goal: 'guard' });
    expect(reactTo({ archetype: 'monster', temper: 'feral' }, 'saw').verb).toBe('confront');
  });

  it('a keeper braces when it SEES, backs away when it only HEARS', () => {
    expect(reactTo({ archetype: 'keeper', temper: 'territorial' }, 'saw').verb).toBe('brace');
    expect(reactTo({ archetype: 'keeper', temper: 'territorial' }, 'heard').verb).toBe('back-away');
  });

  it('a cleric moves to shield the victim; a beast flees', () => {
    expect(reactTo({ archetype: 'cleric', temper: 'steady' }, 'saw')).toMatchObject({ verb: 'shield-others', toward: 'victim' });
    expect(reactTo({ archetype: 'beast', temper: 'timid' }, 'saw')).toMatchObject({ verb: 'flee', toward: 'exit' });
  });

  it('a commoner splits by temper: timid flees, steady backs away, bold gawks (then can flee), brave confronts', () => {
    expect(reactTo(commoner('timid'), 'saw').verb).toBe('flee');
    expect(reactTo(commoner('steady'), 'saw').verb).toBe('back-away');
    expect(reactTo(commoner('bold'), 'saw').verb).toBe('gawk');
    expect(reactTo(commoner('bold'), 'heard').verb).toBe('back-away'); // can't gawk at what you didn't see
    expect(reactTo(commoner('brave'), 'saw').verb).toBe('confront'); // an authored-brave commoner
  });
});

describe('personaLine — one-line render for canon/facts', () => {
  it('renders archetype+temper, appending authored colour when present', () => {
    expect(personaLine({ archetype: 'commoner', temper: 'steady' })).toBe('commoner, steady');
    expect(personaLine({ archetype: 'keeper', temper: 'territorial', allegiance: 'the guild', stake: 'his forge' })).toBe('keeper, territorial — loyal to the guild, stake: his forge');
  });
});
