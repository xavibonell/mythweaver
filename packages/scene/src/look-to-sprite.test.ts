import { describe, expect, it } from 'vitest';
import { lookToSprite } from './composer.js';

// The DM emits freeform `look` text per NPC; lookToSprite maps it to a catalog sprite tag. After the
// DawnLike roster pass (27→50 chars) the table was extended so the new creatures resolve to their own
// sprites instead of collapsing into goblin/knight/zombie. This locks in both the new mappings and the
// specific-before-generic ordering (the part that silently breaks if a rule is moved).

describe('lookToSprite — new DawnLike roster resolves to exact sprites', () => {
  it('maps the DM looks from the ogre-attack scene to the right creatures (was goblin/knight/rogue)', () => {
    expect(lookToSprite('a hulking ogre')).toBe('ogre');
    expect(lookToSprite('a kobold')).toBe('kobold');
    expect(lookToSprite('a guard')).toBe('guard');
    expect(lookToSprite('the hooded bandit')).toBe('bandit');
  });

  it('resolves the whole new bestiary', () => {
    const cases: [string, string][] = [
      ['a troll', 'troll'], ['a minotaur', 'minotaur'], ['a cyclops', 'cyclops'], ['an ettin', 'ettin'],
      ['a lich', 'lich'], ['a ghoul', 'ghoul'], ['a wraith', 'wraith'], ['a ghost', 'ghost'],
      ['a shambling mummy', 'mummy'], ['a darting imp', 'imp'], ['a bone devil', 'devil_bone'],
      ['a hobgoblin', 'hobgoblin'], ['a bugbear', 'bugbear'], ['an orc shaman', 'orc_shaman'],
      ['a giant rat', 'rat_giant'], ['a giant spider', 'spider_giant'],
      ['a hill giant', 'giant_hill'], ['a frost giant', 'giant_frost'], ['a stone giant', 'giant_stone'],
    ];
    for (const [look, tag] of cases) expect(lookToSprite(look), look).toBe(tag);
  });

  it('keeps specific-before-generic ordering (the fragile part)', () => {
    expect(lookToSprite('a hobgoblin')).toBe('hobgoblin');       // not 'goblin'
    expect(lookToSprite('a giant spider')).toBe('spider_giant'); // not 'spider'
    expect(lookToSprite('an orc shaman')).toBe('orc_shaman');    // not 'orc' or 'wizard'
    expect(lookToSprite('a barrow wight')).toBe('wraith');       // not 'zombie'
  });

  it('does not regress the pre-existing tags', () => {
    expect(lookToSprite('a goblin')).toBe('goblin');
    expect(lookToSprite('a knight in plate')).toBe('knight');
    expect(lookToSprite('a paladin')).toBe('knight');
    expect(lookToSprite('a sneaky thief')).toBe('rogue');
    expect(lookToSprite('an old wizard')).toBe('wizard');
    expect(lookToSprite('an orc')).toBe('orc');
    expect(lookToSprite('a skeleton')).toBe('skeleton');
    expect(lookToSprite('a shambling zombie')).toBe('zombie');
    expect(lookToSprite('a grey wolf')).toBe('wolf');
    expect(lookToSprite('an old woman')).toBe('villager_woman');
    expect(lookToSprite('a peasant')).toBe('villager'); // fallback
  });
});
