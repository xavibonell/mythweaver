#!/usr/bin/env node
/**
 * ARCHIVIST DRY-RUN (docs/PLAYER-INTERFACE.md P5 — "the diary rails, not the diary").
 *
 * $0, no LLM: folds a finished session's journal into the FactRows the future inter-chapter archivist
 * WOULD write (source:'archivist' — the reserved lane nothing writes yet). The point is falsification
 * while it's cheap: if this fold needs data the events don't carry, the journal schema is wrong and we
 * fix it now, not after a campaign's worth of sessions has been recorded in it.
 *
 * Usage:
 *   node scripts/archivist-dry-run.mjs content/dev-sessions/<slug>.json   # a frozen session
 *   node scripts/archivist-dry-run.mjs path/to/state.json                 # or a raw GameState
 *
 * Prints the proposed rows grouped by subject, then a GAPS report (what the fold wanted but the
 * events lacked). Read the gaps — they are the deliverable.
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/archivist-dry-run.mjs <frozen-session-or-state.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(path, 'utf8'));
const state = raw.state ?? raw; // dev-session freeze {state, meta} or a bare GameState
const journal = state.journal ?? [];
const titles = state.adventure?.scenes ?? {};
const cards = state.ledger?.entities ?? {};
const nameOf = (id) => cards[id]?.name ?? id;

if (!journal.length) {
  console.error('no journal in this state — play a few turns (and close a chapter) before freezing.');
  process.exit(1);
}

const rows = []; // proposed {source:'archivist', subject, attribute, value}
const gaps = [];
const add = (subject, attribute, value) => rows.push({ source: 'archivist', subject, attribute, value });

// ---- chapters: the roll-up unit -------------------------------------------------------------------
const closers = journal.filter((e) => e.kind === 'chapter' && e.data?.from);
for (const c of closers) {
  const beat = String(c.data.from);
  const title = titles[beat]?.title ?? beat;
  const evs = journal.filter((e) => e.beatId === beat);
  add(`beat:${beat}`, 'chapter-outcome', `${title} — ${c.data.outcome ?? '(no outcome recorded)'}`);
  if (!c.data.outcome) gaps.push(`chapter "${title}" closed without an outcome — advanceScene should always pass one`);
  const goal = [...evs].reverse().find((e) => e.kind === 'goal');
  if (goal) add(`beat:${beat}`, 'chapter-goal', goal.text);
  else gaps.push(`chapter "${title}" has no goal snapshot — the planner's partyGoal never landed for it`);
  if (evs.filter((e) => e.kind !== 'chapter').length === 0) gaps.push(`chapter "${title}" closed with zero events — nothing for a diary to keep`);
}
if (!closers.length) gaps.push('no chapter ever closed — drive a session through advanceScene before judging the fold');

// ---- people: who the party met and how it went ----------------------------------------------------
const byCard = new Map();
for (const e of journal) for (const s of e.subjects ?? []) {
  if (!cards[s]) continue;
  const b = byCard.get(s) ?? { met: null, regard: 0, deeds: 0 };
  if (e.kind === 'met' && !b.met) b.met = e.text;
  if (e.kind === 'disposition') b.regard += Number(e.data?.dir ?? 0);
  if (e.kind === 'verdict' || e.kind === 'clue') b.deeds += 1;
  byCard.set(s, b);
}
for (const [id, b] of byCard) {
  add(id, 'met-as', b.met ?? `(no met event — first appeared inside a ${journal.find((e) => e.subjects?.includes(id))?.kind} row)`);
  if (b.regard !== 0) add(id, 'regard-trend', `${b.regard > 0 ? '+' : ''}${b.regard} over the session`);
  if (!b.met) gaps.push(`${nameOf(id)} has no met event — dossier was born from a ${journal.find((e) => e.subjects?.includes(id))?.kind} row (pre-P5 session, or never named in narration)`);
}

// ---- knowledge + spoils ----------------------------------------------------------------------------
for (const e of journal) {
  if (e.kind === 'clue') add(e.subjects?.[0] ?? 'party', 'learned', e.text.replace(/^Learned:\s*/, ''));
  if (e.kind === 'loot') add('party', 'took', e.text);
  if (e.kind === 'finding' && e.data?.status === 'searched') add(e.subjects?.[0] ?? 'party', 'searched', e.text);
  if (e.kind === 'decision') add('party', 'decision', e.text);
}
for (const [key, value] of Object.entries(state.flags ?? {})) {
  if (key.startsWith('decision:')) add('party', key, String(value));
}

// ---- report ----------------------------------------------------------------------------------------
console.log(`\nARCHIVIST DRY-RUN — ${journal.length} journal events → ${rows.length} proposed rows\n`);
const bySubject = new Map();
for (const r of rows) (bySubject.get(r.subject) ?? bySubject.set(r.subject, []).get(r.subject)).push(r);
for (const [subject, rs] of bySubject) {
  console.log(`  ${nameOf(subject)} (${subject})`);
  for (const r of rs) console.log(`    · ${r.attribute}: ${r.value}`);
}
console.log(`\nGAPS (${gaps.length}) — schema debts to settle while they are cheap:`);
for (const g of gaps) console.log(`  ! ${g}`);
if (!gaps.length) console.log('  none — the events carry everything the fold needed.');
console.log('');
