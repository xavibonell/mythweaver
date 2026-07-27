/**
 * THE CHRONICLER (docs/PLAYER-INTERFACE.md P5, "optional, skippable forever").
 *
 * When a chapter closes, one LLM call turns its journal rows into 2–4 sentences of prose shown above
 * the bullets. The input is EXCLUSIVELY the already-player-safe journal lines of that chapter — the
 * chronicler cannot leak what it never sees, which is the same containment argument as the prologue's.
 * Fired-and-forgotten after the closing turn returns, so it costs the table no latency; the poll's
 * journalLen pickup delivers it moments later. Additive color, never truth: a failed or disabled call
 * (MYTHWEAVER_CHRONICLER=off, no key) leaves the Book exactly as it was.
 */

import type { LlmProvider } from '@mythweaver/llm';

const CHRONICLE_SYSTEM = `You are the chronicler of an adventuring company, writing up a finished chapter of their shared journal. You are given the chapter's title, what the company was trying to do, how it ended, and the raw one-line records of what happened.

Write 2-4 sentences of past-tense prose, second person plural ("you"), that tell what the company did and learned in this chapter. Work ONLY from the records given — never invent people, places, causes or outcomes that are not in them. No headings, no lists, no meta words (chapter, session, quest, players). END ON A COMPLETE SENTENCE.`;

/** One call, one paragraph. Returns null on any failure — the chapter simply keeps its bullets. */
export async function generateChronicle(
  llm: LlmProvider,
  args: { title: string; goal?: string; outcome?: string; events: string[] },
): Promise<string | null> {
  try {
    const res = await llm.complete({
      system: CHRONICLE_SYSTEM,
      messages: [{
        role: 'user',
        content: `CHAPTER: ${args.title}\nWHAT YOU WERE TRYING TO DO: ${args.goal ?? '(unstated)'}\nHOW IT ENDED: ${args.outcome ?? '(unstated)'}\n\nTHE RECORDS:\n${args.events.map((e) => `- ${e}`).join('\n')}`,
      }],
      // A reasoning model spends thought INSIDE this budget — 400 starved the prologue mid-sentence once.
      maxTokens: 900,
    });
    let text = res.text.trim();
    // Engine.journal caps a chronicle at 700 chars with an ellipsis cut — clamp to the last complete
    // sentence UNDER the cap here instead, so an over-long reply never lands mid-sentence in the Book.
    if (text.length > 700) {
      const clipped = text.slice(0, 700);
      const cut = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf('!'), clipped.lastIndexOf('?'));
      text = cut > 40 ? clipped.slice(0, cut + 1) : clipped;
    }
    return text.length > 40 ? text : null;
  } catch (err) {
    // Fail soft but never SILENT — a swallowed error in the prologue cost a debugging cycle already.
    console.warn(`chronicle generation failed: ${(err as Error).message}`);
    return null;
  }
}
