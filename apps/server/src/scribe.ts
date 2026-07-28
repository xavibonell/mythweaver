/**
 * THE SCRIBE (docs/PLAYER-INTERFACE.md P5.1) — one line in the Book per turn.
 *
 * The journal's first pass only recorded moments the ENGINE adjudicated: a crowd scattering, an NPC
 * refusing, a chest opened, a chapter closing. A table that spends a whole scene TALKING therefore
 * filled its Book with nothing, which is the opposite of what a Book is for — the first live test of
 * P5 was a two-turn conversation with a villager that left no trace at all.
 *
 * So: after each turn, one small fire-and-forget call turns "what the player said" + "what the DM
 * answered" into a single past-tense line — "Aldric asked after the fuss; Tessa said the seed was
 * taken from the storehouse." It costs the table no latency (the turn has already returned) and it
 * cannot leak, by the same containment argument as the prologue and the chronicler: its ENTIRE input
 * is two texts that were spoken aloud at the table. It is given no state, no ledger, no arc.
 *
 * The scribe records; it never adjudicates. It cannot birth a dossier (subjects are restricted to
 * people the journal already knows) and it never invents an outcome the narration did not state.
 * MYTHWEAVER_SCRIBE=off ⇒ $0 and a Book that behaves exactly as it did before.
 */

import type { LlmProvider } from '@mythweaver/llm';
import { plainProse } from './journal-hooks.js';

const SCRIBE_SYSTEM = `You keep the shared journal of an adventuring company. You are given one thing a player did or said, and the Dungeon Master's answer. Write ONE sentence for the journal.

RULES:
- Past tense, third person, naming the characters involved ("Aldric asked…", "Tessa said…").
- Record what was DONE and what was LEARNED — the substance, not the scenery. If a name, place, motive or number was revealed, that is the part worth keeping.
- Plain, warm chronicle voice. No purple prose, no adjectives for their own sake.
- ONLY what the two texts state. Never infer a cause, a feeling, or an outcome that was not said.
- Under 20 words. ONE sentence — a journal line a player scans in a second, not a paragraph.
- No quotation marks, no markdown, no bullet, no preamble.

Write a line for EVERY turn. The player always did something — approaching someone, asking, moving, trying — and that is worth a line even when the answer was small. Reply SKIP only when the Dungeon Master's text contains no action and no information at all (pure scenery). SKIP should be rare.`;

/** One turn, one line. Returns null when there is nothing worth keeping (or on any failure). */
export async function summarizeBeat(
  llm: LlmProvider,
  args: { playerLine: string; speaker?: string; narration: string },
): Promise<string | null> {
  try {
    if (!args.narration.trim() || !args.playerLine.trim()) return null;
    const res = await llm.complete({
      system: SCRIBE_SYSTEM,
      messages: [{
        role: 'user',
        content: `${args.speaker ?? 'A player'}: ${args.playerLine.slice(0, 600)}\n\nDungeon Master: ${args.narration.slice(0, 2000)}`,
      }],
      // A reasoning model spends its thinking INSIDE this budget — 200 would starve the sentence.
      maxTokens: 600,
    });
    const text = plainProse(res.text.trim().replace(/^["'“]|["'”]$/g, ''));
    if (!text || /^SKIP\b/i.test(text) || text.length < 12) return null;
    return text;
  } catch (err) {
    // Fail soft but never SILENT — a swallowed error here costs a debugging cycle.
    console.warn(`beat summary failed: ${(err as Error).message}`);
    return null;
  }
}
