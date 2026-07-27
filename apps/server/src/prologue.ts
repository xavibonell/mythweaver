/**
 * THE PLAYER PROLOGUE (docs/PLAYER-INTERFACE.md P4.1) — the Book's opening page.
 *
 * The Book used to open with the Director's PITCH ("A grounded village mystery… the party must
 * uncover…") — a design document, written ABOUT the players from above. The table flagged it
 * immediately: players should open their Book to a STORY — who you are, how you came to be here, what
 * the evening smells like — in the same voice the DM speaks with.
 *
 * So: one LLM call per session, fired-and-forgotten at create so it costs the table no latency, landing
 * as a `prologue` journal event when it's ready (the poll's journalLen pickup delivers it a few seconds
 * after the table opens). The register is borrowed from the style-exemplar RAG — the same real-DM
 * scene-set beats the turn narration draws on — so the Book's first page sounds like the table's DM,
 * not like a back-cover blurb. Degrades to silence: no key or a failed call simply leaves the Book
 * opening on the premise fallback.
 *
 * The prompt only ever sees player-known material: the premise (as private inspiration), the authored
 * opening, and the party's own names/classes/backstories. No ending, no spine, no NPC secrets — the
 * prologue cannot leak what it was never shown.
 */

import type { LlmProvider } from '@mythweaver/llm';
import type { ExemplarRetriever } from './exemplar-corpus.js';

export interface ProloguePartyMember {
  name: string;
  className?: string;
  ancestry?: string;
  backstory?: string;
}

const PROLOGUE_SYSTEM = `You are a Dungeon Master opening a campaign for the players sitting at your table. Write the OPENING PAGE of their shared journal: 2-3 short paragraphs, second person plural ("you"), present tense.

It must do three things, in the fiction and only in the fiction:
1. WHO YOU ARE — name each character once, with a single breath of who they are (their trade, their manner, a detail from their past). Weave them together as a group, don't list them.
2. HOW YOU GOT HERE — the road, the reason, the rumor or debt or letter that brought them, drawn from what you're given.
3. WHERE YOU STAND NOW — end in the present moment and place, concrete and sensory, at the instant play begins.

HARD RULES: never use meta words (campaign, party, quest, objective, players, session). Reveal nothing the characters would not know — no villains named, no twists, no outcomes. No headings, no lists — just prose. Keep it under 170 words and END ON A COMPLETE SENTENCE; a table wants to play, not to read a novel.`;

/** One call, one page. Returns null on any failure — the Book simply opens without it. */
export async function generatePrologue(
  llm: LlmProvider,
  exemplars: ExemplarRetriever | undefined,
  args: { premise?: string; opening?: string; sceneTitle?: string; party: ProloguePartyMember[]; temperature?: number },
): Promise<string | null> {
  try {
    const partyLines = args.party
      .map((p) => `- ${p.name}${p.className ? `, a ${[p.ancestry, p.className].filter(Boolean).join(' ').toLowerCase()}` : ''}${p.backstory ? ` — ${p.backstory.slice(0, 200)}` : ''}`)
      .join('\n');
    // Borrow the register from real-DM opening beats (voice only — the exemplars carry no plot).
    let voice = '';
    if (exemplars) {
      try {
        const hits = await exemplars.retrieve(`${args.premise ?? ''} ${args.opening ?? ''}`.trim() || 'a campaign opening', 2, 'scene-set');
        if (hits.length) voice = `\n\nREGISTER (match this voice, never reuse the words):\n${hits.map((h) => `"${h.text.slice(0, 220)}"`).join('\n')}`;
      } catch { /* style is a bonus, never a blocker */ }
    }
    const res = await llm.complete({
      system: PROLOGUE_SYSTEM,
      messages: [{
        role: 'user',
        content: `PRIVATE INSPIRATION (never quote or summarize it — it is a synopsis, not a story): ${args.premise ?? '(none)'}\n\nHOW THE STORY OPENS: ${args.opening ?? '(unknown)'}\nTHE PLACE: ${args.sceneTitle ?? '(unnamed)'}\n\nTHE CHARACTERS:\n${partyLines}${voice}`,
      }],
      maxTokens: 900,
      ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
    });
    const text = res.text.trim();
    return text.length > 60 ? text : null; // a one-liner means the call went sideways
  } catch (err) {
    // Fail soft but never SILENT — a swallowed error here cost a debugging cycle once already.
    console.warn(`prologue generation failed: ${(err as Error).message}`);
    return null;
  }
}
