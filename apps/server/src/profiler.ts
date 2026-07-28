/**
 * THE PROFILER (docs/PLAYER-INTERFACE.md B3) — the party's READ on a person, kept as a sheet.
 *
 * A dossier used to be a list of things that happened, which is what the Journal already is; opening
 * Tessa's entry to re-read the same two sentences told the table nothing. What players actually carry
 * between sessions is a JUDGEMENT: what she's like, what she can do, what she's carrying, whether she
 * seems to be holding something back. That is what this call maintains.
 *
 * Shape of the thing (all optional, all PERCEIVED):
 *   · manner   — how she comes across, in one line
 *   · traits   — 2-5 observed character notes ("protective of the village")
 *   · carries  — possessions and capabilities actually SEEN or stated ("a key at her belt")
 *   · candor   — the withholding read ("answers freely" / "steers you toward the road")
 *
 * Containment, same argument as the prologue/scribe/chronicler: its entire input is the previous sheet
 * plus the words spoken aloud this turn. It never sees the ledger's want/fear/notes, the arc, or any
 * DC — so it cannot leak them, and everything it writes is by construction a table-side impression.
 * REGARD is NOT its business: that stays the engine's witnessed-shift counter.
 *
 * It refines rather than rewrites — the previous sheet goes in, and the prompt forbids discarding an
 * observation that still holds, so one thin turn cannot flatten a rich read.
 *
 * APPEARANCE is canon (B2) and normally arrives with the character card. When a card predates the
 * field (older campaigns, frozen fixtures), the profiler may propose ONE — distilled from what the DM
 * already said aloud, never invented freely — and the engine's write-once guard makes that first value
 * permanent. Consistency comes from there being exactly one string, wherever it was born.
 */

import type { LlmProvider } from '@mythweaver/llm';
import { plainProse } from './journal-hooks.js';

export interface PerceivedSheet {
  manner?: string;
  traits?: string[];
  carries?: string[];
  candor?: string;
  /** Only ever set when the card had NO canonical appearance; the engine keeps the first value. */
  appearance?: string;
}

const PROFILER_SYSTEM = `You maintain an adventuring party's notes ON A PERSON they have met. You are given what the party already thinks of them, and everything that was said and done aloud this turn. Return the UPDATED notes as JSON.

{"manner":"<one line: how they come across>","traits":["<observed trait>"],"carries":["<a possession or capability the party SAW or was told about>"],"candor":"<one line: do they seem forthcoming, evasive, steering?>","appearance":"<ONLY if asked for below>"}

RULES:
- These are IMPRESSIONS, not facts. Write what the party could reasonably conclude from what they witnessed. Hedge honestly ("seems", "claims", "so far") where the evidence is thin.
- REFINE, never discard: keep every earlier note that still holds, sharpen it if this turn added something, and only drop one if this turn CONTRADICTED it.
- Never invent. If nothing new was learned, return the notes unchanged.
- OMIT ANY FIELD YOU CANNOT FILL FROM EVIDENCE. Never write "unknown", "not assessed", "not directly observed" or any other placeholder — an empty entry is honest, a placeholder is noise. Someone merely NAMED by another person gets almost nothing, and that is correct.
- "carries" is strictly PHYSICAL: things seen on them or stated to be theirs — a key at her belt, a limping leg, a smith's burns on the hands. NOT what they said, know, claim or suspect (that is the party's journal, not their pockets).
- "traits" is observed CHARACTER — how they behave, what they care about. Not a summary of the conversation.
- 2-5 traits maximum, each a short phrase. No paragraphs anywhere. Under 20 words per line.
- Output JSON only. No prose around it.`;

/** Placeholder prose the model reaches for when it has nothing — an empty sheet says it better. */
const PLACEHOLDER = /^(unknown|none|n\/?a|not (yet )?(assessed|observed|known|established)|nothing (yet|known)|no (information|data))\b/i;
const usable = (s: string) => !!s && !PLACEHOLDER.test(s);

const arr = (v: unknown, max: number, len: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => plainProse(String(x)).slice(0, len)).filter(usable).slice(0, max);
const one = (v: unknown, len: number): string | undefined => {
  const s = typeof v === 'string' ? plainProse(v).slice(0, len) : '';
  return usable(s) ? s : undefined;
};

/** Update one person's perceived sheet. Returns null when nothing usable came back. */
export async function profilePerson(
  llm: LlmProvider,
  args: { name: string; prior?: PerceivedSheet; playerLine: string; narration: string; needsAppearance?: boolean },
): Promise<PerceivedSheet | null> {
  try {
    const priorText = args.prior && Object.keys(args.prior).length
      ? JSON.stringify({ manner: args.prior.manner, traits: args.prior.traits, carries: args.prior.carries, candor: args.prior.candor })
      : '(nothing yet — this is the first read)';
    const askAppearance = args.needsAppearance
      ? `\n\nALSO: the party has no physical description of ${args.name} on file. If the text below shows what they LOOK like, set "appearance" to one line of observable surface (build, rough age, dress, one memorable feature) drawn ONLY from what was said. If the text does not describe them, omit the field entirely — do not invent a face.`
      : '\n\nDo NOT include an "appearance" field.';
    const res = await llm.complete({
      system: PROFILER_SYSTEM,
      messages: [{
        role: 'user',
        content: `THE PERSON: ${args.name}\n\nWHAT THE PARTY ALREADY THINKS:\n${priorText}\n\nWHAT HAPPENED ALOUD THIS TURN:\n${args.playerLine.slice(0, 600)}\n\n${args.narration.slice(0, 2000)}${askAppearance}`,
      }],
      // A reasoning model spends its thinking INSIDE this budget (the prologue lesson).
      maxTokens: 900,
    });
    const m = /\{[\s\S]*\}/.exec(res.text);
    if (!m) return null;
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const sheet: PerceivedSheet = {
      ...(one(o.manner, 120) ? { manner: one(o.manner, 120)! } : {}),
      ...(arr(o.traits, 5, 80).length ? { traits: arr(o.traits, 5, 80) } : {}),
      ...(arr(o.carries, 6, 80).length ? { carries: arr(o.carries, 6, 80) } : {}),
      ...(one(o.candor, 120) ? { candor: one(o.candor, 120)! } : {}),
      ...(args.needsAppearance && one(o.appearance, 200) ? { appearance: one(o.appearance, 200)! } : {}),
    };
    return Object.keys(sheet).length ? sheet : null;
  } catch (err) {
    // Fail soft but never SILENT — a swallowed error here costs a debugging cycle.
    console.warn(`profile update failed for ${args.name}: ${(err as Error).message}`);
    return null;
  }
}
