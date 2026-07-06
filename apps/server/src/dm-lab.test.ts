import { describe, expect, it } from 'vitest';
import { Engine, createInitialState } from '@mythweaver/engine';
import { FakeLlmProvider } from '@mythweaver/llm';
import type { CharacterSheet } from '@mythweaver/shared';
import { characterSheets, createDmLabSession, type DmLabSession } from './dm-lab.js';

function wizard(): CharacterSheet {
  return {
    id: 'elara',
    name: 'Elara',
    ancestry: 'High Elf',
    className: 'Wizard',
    level: 1,
    abilities: { str: 8, dex: 14, con: 13, int: 16, wis: 11, cha: 10 },
    proficiencyBonus: 2,
    armorClass: 12,
    maxHitPoints: 8,
    speedFt: 30,
    skillProficiencies: ['arcana', 'investigation'],
    savingThrowProficiencies: ['int', 'wis'],
    attacks: [{ name: 'Fire Bolt', attackBonus: 5, damage: '1d10', damageType: 'fire' }],
    spellcasting: { ability: 'int', spellSaveDc: 13, spellAttackBonus: 5, slots: [0, 2], cantrips: ['fire bolt'], prepared: ['magic missile'], rituals: ['Detect Magic'] },
    startingCurrency: { gp: 10 },
  };
}

describe('sceneEngine knob (lab sessions pick real vs $0 scene generation)', () => {
  const realizeScene = async () => null;

  it("defaults to 'modern' when a realizer is wired (the lab is the test-play surface)", () => {
    const s = createDmLabSession({ llm: new FakeLlmProvider([]), realizeScene }, 'the-sunken-bell');
    expect(s.sceneEngine).toBe('modern');
    expect(s.realizeScene).toBe(realizeScene);
  });

  it("'fake' drops the modern realizer so setScene costs $0", () => {
    const s = createDmLabSession({ llm: new FakeLlmProvider([]), realizeScene, sceneEngine: 'fake' }, 'the-sunken-bell');
    expect(s.sceneEngine).toBe('fake');
    expect(s.realizeScene).toBeUndefined();
  });

  it("no realizer wired at all → the session reports 'fake' honestly", () => {
    const s = createDmLabSession({ llm: new FakeLlmProvider([]) }, 'the-sunken-bell');
    expect(s.sceneEngine).toBe('fake');
  });
});

describe('characterSheets (Run-view sheet serializer)', () => {
  const view = () => {
    const state = createInitialState({ sessionId: 's', scenarioId: 't', startSceneId: 'x', party: [wizard()] });
    return characterSheets({ engine: new Engine(state) } as unknown as DmLabSession);
  };

  it('joins the sheet + engine-derived numbers for a caster', () => {
    const [pc] = view();
    expect(pc!.name).toBe('Elara');
    expect(pc!.hp).toEqual({ cur: 8, max: 8, temp: 0 });
    expect(pc!.xpNext).toBe(300);
    expect(pc!.currency).toEqual({ cp: 0, sp: 0, gp: 10 });
    expect(pc!.carry).toEqual({ lb: 0, cap: 120, over: false }); // STR 8 × 15
  });

  it('derives skill tiers + modifiers and the spell save DC exactly like the engine', () => {
    const [pc] = view();
    const arcana = pc!.skills.find((s) => s.key === 'arcana')!;
    expect(arcana).toMatchObject({ tier: 'proficient', mod: 5, ability: 'int' }); // INT +3 + prof 2
    const stealth = pc!.skills.find((s) => s.key === 'stealth')!;
    expect(stealth).toMatchObject({ tier: 'none', mod: 2 }); // DEX +2, no prof
    const intAbility = pc!.abilities.find((a) => a.key === 'int')!;
    expect(intAbility).toMatchObject({ mod: 3, saveProf: true, save: 5 });
    expect(pc!.spellcasting!.saveDc).toBe(13); // 8 + prof 2 + INT 3
    expect(pc!.spellcasting!.preparedMax).toBe(4); // INT 3 + level 1
    expect(pc!.slots).toEqual([{ level: 1, cur: 2, max: 2 }]);
    expect(pc!.spellcasting!.rituals).toContain('Detect Magic');
  });
});
