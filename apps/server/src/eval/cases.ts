/** Eval cases (spec §10). Each runs through the real brain; we judge the last turn's narration. */

/** A player message, or a declared physical-dice total resolving a roll the DM requested. */
export type EvalTurn = { speakerId: string; text: string } | { roll: number };

/**
 * Deterministic tool-use expectation (spec §10 component 1: rules-correctness checks).
 * Checked against EVERY tool call the case made — not the fuzzy judge. A failure blocks
 * the gate: it means the DM resolved a mechanic the wrong way (e.g. didn't ask for a roll).
 */
export interface ToolExpectation {
  /** Tool names that MUST appear at least once across the case. */
  required?: string[];
  /** Tool names that must NEVER appear (e.g. don't request a roll for an impossible action). */
  forbidden?: string[];
}

export interface EvalCase {
  id: string;
  scenario: string;
  /** Player turns (and any declared rolls); the narration of the LAST turn is judged. */
  turns: EvalTurn[];
  note: string;
  /** Deterministic tool-use assertions (rules fidelity), independent of the LLM judge. */
  expectTools?: ToolExpectation;
}

export const EVAL_CASES: EvalCase[] = [
  {
    id: 'opening-scene',
    scenario: 'the-sunken-bell',
    turns: [{ speakerId: 'Aldric', text: 'We arrive at the Mistmoor green at dusk and take in the scene.' }],
    note: 'Scene-setting + sticks to the authored premise (Edda, the silent bell, the tower).',
    expectTools: { required: ['setScene'] },
  },
  {
    id: 'persuade-edda',
    scenario: 'the-sunken-bell',
    turns: [{ speakerId: 'Brakka', text: 'I sense Edda is hiding something and gently press her for the truth about the bell.' }],
    note: 'Should request a Persuasion/Insight check, not decide success itself (rules fidelity).',
    expectTools: { required: ['requestRoll'] },
  },
  {
    id: 'rules-lookup',
    scenario: 'the-sunken-bell',
    turns: [{ speakerId: 'Pip', text: '(To the DM) Before we go in, how exactly does the grappling rule work?' }],
    note: 'Should look up + ground the rule rather than improvise mechanics (source faithfulness).',
    expectTools: { required: ['lookupRule'] },
  },
  {
    id: 'out-of-depth',
    scenario: 'the-sunken-bell',
    turns: [{ speakerId: 'Pip', text: 'I cast the Wish spell to erase the bell-tower from existence.' }],
    note: 'Level-1 characters have no Wish; should refuse by fiction without inventing mechanics or rolling.',
    expectTools: { forbidden: ['requestRoll'] },
  },
  {
    id: 'agency',
    scenario: 'the-sunken-bell',
    turns: [{ speakerId: 'Aldric', text: 'Forget the tower — I want to leave Mistmoor entirely and go fishing for the day.' }],
    note: 'Should honor the choice (player agency), not railroad back to the plot.',
  },
  {
    id: 'roll-resume',
    scenario: 'the-sunken-bell',
    turns: [
      { speakerId: 'Aldric', text: 'I scale the slick stone to the broken upper window of the tower.' },
      { roll: 17 },
    ],
    note: 'Requests an Athletics check, then narrates the ENGINE verdict for the declared roll — never overturns it.',
    expectTools: { required: ['requestRoll'] },
  },
  {
    id: 'combat-attack',
    scenario: 'the-sunken-bell',
    turns: [
      { speakerId: 'Pip', text: 'A goblin bursts from the reeds at me — I draw and loose an arrow at it!' },
      { roll: 14 },
    ],
    note: 'Combat: must roll the attack vs the goblin AC (engine decides the hit); narrate the verdict, no invented HP.',
    expectTools: { required: ['requestRoll'] },
  },
  {
    id: 'continuity',
    scenario: 'the-sunken-bell',
    turns: [
      { speakerId: 'Brakka', text: 'I greet Edda warmly and ask what happened to the bell.' },
      { speakerId: 'Brakka', text: 'I press her gently — and ask about the fisher who went missing.' },
    ],
    note: 'Second turn must stay consistent with Edda + the established scene (coherence & continuity).',
  },
  {
    id: 'reach-question',
    scenario: 'the-sunken-bell',
    turns: [{ speakerId: 'Aldric', text: 'Can we even reach the tower from here, or is it cut off? Do we need a boat?' }],
    note: 'A FEASIBILITY QUESTION, not a declared move — must ANSWER (not silently walk/swim the party there). The engine has no business moving a token off a question.',
    expectTools: { forbidden: ['travel'] },
  },
];
