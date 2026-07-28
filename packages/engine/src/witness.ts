/**
 * WHO PERCEIVED IT (docs/PLAYER-INTERFACE.md B1) — the deterministic witness set for a journal event.
 *
 * The Book records what the party knows. Today the party shares one screen, so "the party" and "the
 * character who was there" are the same audience — but the moment play splits (one PC upstairs, two in
 * the taproom), a journal that never recorded WHO was present cannot be partitioned after the fact.
 * So every perceptual event carries its witnesses from the first slice, whether or not any UI splits
 * on them yet.
 *
 * The rule is geometric and engine-owned — never the narrator's opinion:
 *   · no map, or a non-perceptual event (the prologue, a chapter boundary, the chronicler's prose)
 *     ⇒ no witness list at all;
 *   · an event with an ORIGIN (someone spoke, something happened at a spot) ⇒ the PCs within earshot
 *     of that origin;
 *   · an event without one ⇒ every PC present in the location, because it happened around them.
 *
 * Hidden PCs are still witnesses: a rogue watching from the shadows perceives the moment perfectly
 * well — invisibility hides them from OTHERS, it does not blind them.
 */

import type { JournalEvent, SceneMap } from '@mythweaver/shared';

/** A raised voice carries about this far in a busy village (mirrors the interaction layer's gate). */
export const WITNESS_EARSHOT_FT = 60;

/** Kinds nobody stands in a place and perceives — bookkeeping and authored prose. */
const NON_PERCEPTUAL = new Set<JournalEvent['kind']>(['prologue', 'chronicle', 'chapter', 'goal']);

/** PC token ids that perceived this moment, or undefined when the question doesn't apply. */
export function journalWitnesses(map: SceneMap | undefined, kind: JournalEvent['kind'], origin?: string): string[] | undefined {
  if (!map || NON_PERCEPTUAL.has(kind)) return undefined;
  const objects = map.objects ?? [];
  const pcs = objects.filter((o) => o.kind === 'actor' && o.role === 'pc');
  if (!pcs.length) return undefined;

  // The origin may be given as a token id OR as the DM-facing NAME of the actor who acted (the scribe
  // knows "Aldric", not "pc:pc-1-fighter"), so accept either.
  const src = origin
    ? objects.find((o) => o.id === origin) ?? objects.find((o) => (o.name ?? '').toLowerCase() === origin.toLowerCase())
    : undefined;
  if (!src) return pcs.map((p) => p.id); // present in the location ⇒ it happened around them

  const feetPerTile = map.grid?.feetPerTile ?? 5;
  return pcs
    .filter((p) => Math.max(Math.abs(p.col - src.col), Math.abs(p.row - src.row)) * feetPerTile <= WITNESS_EARSHOT_FT)
    .map((p) => p.id);
}
