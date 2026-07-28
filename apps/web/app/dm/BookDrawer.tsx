'use client';

/**
 * THE BOOK (docs/PLAYER-INTERFACE.md P4) — what the party knows, on the table.
 *
 * ONE floating bookmark on the left edge opens the whole Book; Journal / People / Findings are TABS
 * inside it (three separate floating icons read as three separate features — they aren't; they're pages
 * of the same book). Deliberately NON-MODAL and closed only by an explicit click: at a real table one
 * player reads while another acts, so click-outside-to-close would slam shut every time someone else
 * touched the map.
 *
 * Everything here renders the journal the engine wrote (P3) — the events are already player-safe, so
 * this file does no filtering, only arrangement. The Book is an INDEX of what mattered, not a retelling:
 * one line per moment, with the prose left where it belongs, in the transcript.
 *
 * Two ergonomics that are requirements rather than polish, because the table re-hydrates every 2s:
 *  · all three tabs stay MOUNTED and are toggled with CSS, so switching or polling never remounts a
 *    scroll container out from under a reader;
 *  · lists keep FIRST-MET order and never re-sort, so rows don't slide around under a finger.
 */

import { useState } from 'react';
import { SPRITES, DEFAULT_SPRITE } from '../play/manifest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ICON: Record<string, string> = {
  chapter: '📕', goal: '🎯', place: '📍', beat: '·', met: '◇', verdict: '›', disposition: '💬', finding: '🔍', loot: '🎒', clue: '◈', decision: '◆',
};

/**
 * A PORTRAIT is the person's own map sprite, blown up — the pixel art the table is already looking
 * at, so a face in the Book and a token on the green are recognisably the same villager. Frame 0 of
 * the idle sheet: the box is one frame wide and the sheet is scaled by height, so frames 1..n stay
 * outside the box. Falls back to a plain silhouette tag if the library hasn't loaded yet.
 */
function Portrait({ tag, size = 34 }: { tag?: string; size?: number }) {
  const s = SPRITES[tag ?? ''] ?? SPRITES[DEFAULT_SPRITE];
  const scale = s ? size / s.frameH : 2;
  return (
    <div
      style={{
        flex: '0 0 auto', width: s ? s.frameW * scale : size, height: size,
        border: '1px solid #2b3542', borderRadius: 4, background: '#171a21',
        ...(s ? {
          backgroundImage: `url(${s.src})`,
          backgroundSize: `auto ${s.frameH * scale}px`,
          backgroundPosition: '0 0',
          backgroundRepeat: 'no-repeat',
          imageRendering: 'pixelated' as const,
        } : {}),
      }}
    />
  );
}

const TABS = [
  { key: 'journal', mark: '📖', label: 'Journal' },
  { key: 'people', mark: '👥', label: 'People' },
  { key: 'findings', mark: '🎒', label: 'Findings' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const C = {
  spine: { position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', zIndex: 30, display: 'flex', flexDirection: 'column', gap: 4 } as React.CSSProperties,
  tab: (on: boolean) => ({
    width: 42, padding: '10px 0', cursor: 'pointer', border: '1px solid #23262f', borderLeft: 'none',
    borderRadius: '0 8px 8px 0', background: on ? '#c9a227' : 'rgba(15,17,22,0.9)', color: on ? '#141414' : '#9aa0b0',
    fontSize: 15, lineHeight: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
  } as React.CSSProperties),
  count: (on: boolean) => ({ fontSize: 9, fontWeight: 700, color: on ? '#141414' : '#6b7080' } as React.CSSProperties),
  drawer: {
    position: 'absolute', left: 42, top: 0, bottom: 0, width: 'min(400px, 34vw)', zIndex: 29,
    background: 'rgba(12,14,19,0.97)', borderRight: '1px solid #23262f', color: '#d8dbe2',
    display: 'flex', flexDirection: 'column', backdropFilter: 'blur(3px)',
  } as React.CSSProperties,
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid #1d2027' } as React.CSSProperties,
  body: { flex: 1, overflowY: 'auto', padding: '10px 12px' } as React.CSSProperties,
  sub: { color: '#6b7080', fontSize: 11 } as React.CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', fontSize: 12, lineHeight: 1.45 } as React.CSSProperties,
  empty: { color: '#565b66', fontSize: 12, fontStyle: 'italic', lineHeight: 1.6 } as React.CSSProperties,
  chapTitle: { fontFamily: 'ui-serif, Georgia, serif', color: '#c9a227', fontSize: 14, marginTop: 12 } as React.CSSProperties,
};

function EventRow({ e, pingId, onPing }: { e: any; pingId?: string | null; onPing?: (id: string) => void }) {
  return (
    <div style={C.row}>
      <span style={{ flex: '0 0 auto', width: 15 }}>{ICON[e.kind] ?? '·'}</span>
      <span style={{ flex: 1 }}>{e.text}</span>
      {pingId && onPing && <PingBtn onClick={() => onPing(pingId)} />}
      <span style={{ ...C.sub, flex: '0 0 auto' }}>t{e.turn}</span>
    </div>
  );
}

/** Book→map (P5): pulse the thing this line is about, over on the canvas. */
function PingBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      title="show on map"
      onClick={(ev) => { ev.stopPropagation(); onClick(); }}
      style={{ flex: '0 0 auto', background: 'transparent', border: '1px solid #2b3542', color: '#c9a227', borderRadius: 4, padding: '0 5px', cursor: 'pointer', fontSize: 11, lineHeight: '16px' }}
    >⌖</button>
  );
}

/** How the party is regarded, in words — accumulated from witnessed shifts only, never a stat. */
function regardWord(n: number): { word: string; color: string } {
  if (n <= -3) return { word: 'hostile', color: '#c0533f' };
  if (n <= -1) return { word: 'wary of you', color: '#d08f7f' };
  if (n === 0) return { word: 'neutral', color: '#8a90a0' };
  if (n <= 2) return { word: 'warm', color: '#7fb389' };
  return { word: 'devoted', color: '#3fa34d' };
}

export default function BookDrawer({ book, arc, selected, onSelect, mapObjects = [], onPing, artRev = 0 }: { book: any; arc: any; selected: string | null; onSelect: (id: string | null) => void; mapObjects?: any[]; onPing?: (id: string) => void; artRev?: number }) {
  void artRev; // repaint trigger only — SPRITES is a module table the Portrait reads at render time
  const [tab, setTab] = useState<TabKey | null>(null);
  const chapters: any[] = book?.chapters ?? [];
  const people: any[] = book?.people ?? [];
  const findings: any[] = book?.findings ?? [];
  // Book→map resolution mirrors click-to-inspect's, in reverse: token id first, DM-given name second.
  // The name bridge is LOAD-BEARING for people rows — journal subjects are ledger CARD ids while map
  // tokens carry their own ids (card 'npc:tessa-reed' vs token 'npc:loc-…-villager-5'); the two id
  // spaces only meet through the name. Only what is on the CURRENT, player-safe map is pingable — the
  // projection already dropped the rest.
  const pingFor = (d: { id?: string; name?: string }): string | null =>
    mapObjects.find((o) => o.visible !== false && (o.id === d.id || (o.name && o.name === d.name)))?.id ?? null;
  /** The token a dossier belongs to — the same name bridge the pings use (card ids ≠ token ids). */
  const tokenFor = (d: { id?: string; name?: string }): any =>
    mapObjects.find((o) => o.visible !== false && (o.id === d.id || (o.name && o.name === d.name)));
  const pingForSubjects = (subjects?: string[]): string | null => {
    for (const s of subjects ?? []) {
      const direct = mapObjects.find((o) => o.visible !== false && o.id === s);
      if (direct) return direct.id;
      const person = people.find((p) => p.id === s);
      const byName = person && pingFor(person);
      if (byName) return byName;
    }
    return null;
  };
  const counts: Record<TabKey, number> = {
    journal: chapters.reduce((n, c) => n + (c.events?.length ?? 0), 0),
    people: people.length,
    findings: findings.length,
  };
  const dossier = selected ? people.find((p) => p.id === selected) : null;
  // A token click opens People even if the drawer was shut — that is the point of the affordance.
  const openTab: TabKey | null = selected ? 'people' : tab;

  return (
    <>
      <div style={C.spine}>
        <button
          title="The Book"
          onClick={() => { if (openTab) { setTab(null); onSelect(null); } else setTab('journal'); }}
          style={C.tab(!!openTab)}
        >
          <span>📖</span>
          <span style={C.count(!!openTab)}>{counts.journal + counts.people + counts.findings || ''}</span>
        </button>
      </div>

      {openTab && (
        // stopPropagation keeps clicks/scrolls off the Phaser canvas underneath.
        <div style={C.drawer} onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
          <div style={C.head}>
            <span style={{ fontFamily: 'ui-serif, Georgia, serif', color: '#c9a227', fontSize: 14 }}>
              {dossier ? dossier.name : 'The Book'}
            </span>
            <button
              onClick={() => (dossier ? onSelect(null) : (setTab(null), onSelect(null)))}
              style={{ background: 'transparent', border: '1px solid #2b3542', color: '#9aa0b0', borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
            >
              {dossier ? '‹ back' : '✕'}
            </button>
          </div>
          {!dossier && (
            <div style={{ display: 'flex', borderBottom: '1px solid #1d2027' }}>
              {TABS.map((t) => {
                const on = openTab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => { setTab(t.key); if (t.key !== 'people') onSelect(null); }}
                    style={{
                      flex: 1, padding: '8px 0', cursor: 'pointer', background: 'transparent', border: 'none',
                      borderBottom: on ? '2px solid #c9a227' : '2px solid transparent',
                      color: on ? '#c9a227' : '#8a90a0', fontSize: 12, fontWeight: on ? 700 : 400,
                    }}
                  >
                    {t.mark} {t.label}{counts[t.key] ? ` · ${counts[t.key]}` : ''}
                  </button>
                );
              })}
            </div>
          )}

          {/* All three panels stay mounted; only display toggles (see the header note). */}
          <div style={{ ...C.body, display: openTab === 'journal' ? 'block' : 'none' }}>
            {(book?.prologue || arc?.premise) && (
              <div style={{ fontFamily: 'ui-serif, Georgia, serif', fontSize: 13, lineHeight: 1.7, color: '#cfd3dc', paddingBottom: 10, borderBottom: '1px solid #1d2027' }}>
                {(book?.prologue ?? arc.premise).split(/\n\n+/).map((para: string, i: number) => (
                  <p key={i} style={{ margin: i ? '10px 0 0' : 0 }}>{para}</p>
                ))}
              </div>
            )}
            {arc?.goal && <div style={{ ...C.row, color: '#c9a227', marginTop: 8 }}><span>🎯</span><span>{arc.goal}</span></div>}
            {!counts.journal && <div style={{ ...C.empty, marginTop: 12 }}>Nothing recorded yet — what you discover, decide and survive lands here.</div>}
            {chapters.map((c) => (
              <div key={c.beatId}>
                <div style={C.chapTitle}>{c.current ? '● ' : '✓ '}{c.title}{c.outcome ? <span style={C.sub}> — {c.outcome}</span> : null}</div>
                {c.goal && <div style={{ ...C.sub, fontStyle: 'italic', marginBottom: 3 }}>Goal: {c.goal}</div>}
                {/* The chronicler's prose over a closed chapter — the bullets stay underneath as the record. */}
                {c.summary && (
                  <div style={{ fontFamily: 'ui-serif, Georgia, serif', fontSize: 12.5, lineHeight: 1.65, color: '#b9bec9', fontStyle: 'italic', margin: '4px 0 6px', paddingLeft: 8, borderLeft: '2px solid #2b3542' }}>
                    {c.summary}
                  </div>
                )}
                {(c.events ?? []).map((e: any) => <EventRow key={e.seq} e={e} pingId={pingForSubjects(e.subjects)} onPing={onPing} />)}
              </div>
            ))}
          </div>

          <div style={{ ...C.body, display: openTab === 'people' ? 'block' : 'none' }}>
            {dossier ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Portrait tag={tokenFor(dossier)?.tag} size={48} />
                  <span style={{ ...C.sub, flex: 1 }}>
                    First met turn {dossier.firstSeen?.turn} · last seen turn {dossier.lastSeen?.turn}
                  </span>
                  {onPing && pingFor(dossier) && <PingBtn onClick={() => onPing(pingFor(dossier)!)} />}
                </div>
                {/* The sentence that introduced them — the DM's own words, kept as the first impression. */}
                {dossier.intro && (
                  <div style={{ fontFamily: 'ui-serif, Georgia, serif', fontStyle: 'italic', fontSize: 12.5, lineHeight: 1.6, color: '#b9bec9', marginTop: 8 }}>
                    &ldquo;{dossier.intro}&rdquo;
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  Seems <b style={{ color: regardWord(dossier.regard).color }}>{regardWord(dossier.regard).word}</b>
                </div>
                <div style={{ ...C.chapTitle, marginTop: 14 }}>Seen to</div>
                {dossier.deeds?.length
                  ? dossier.deeds.map((d: any) => <div key={d.seq} style={C.row}><span style={{ flex: '0 0 auto', width: 15 }}>·</span><span style={{ flex: 1 }}>{d.text}</span><span style={C.sub}>t{d.turn}</span></div>)
                  : <div style={C.empty}>You&rsquo;ve only just met.</div>}
              </div>
            ) : people.length ? (
              people.map((p) => {
                const r = regardWord(p.regard);
                return (
                  <button key={p.id} onClick={() => onSelect(p.id)} style={{ display: 'flex', width: '100%', gap: 10, justifyContent: 'space-between', alignItems: 'center', background: 'transparent', border: 'none', borderBottom: '1px solid #16181e', color: '#d8dbe2', padding: '8px 2px', cursor: 'pointer', textAlign: 'left' }}>
                    <Portrait tag={tokenFor(p)?.tag} />
                    <span style={{ flex: 1, fontSize: 13 }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: r.color }}>{r.word} ›</span>
                  </button>
                );
              })
            ) : <div style={C.empty}>No one yet. People you meet take their place here.</div>}
          </div>

          <div style={{ ...C.body, display: openTab === 'findings' ? 'block' : 'none' }}>
            {findings.length
              ? findings.map((f: any) => <EventRow key={f.seq} e={f} pingId={pingForSubjects(f.subjects)} onPing={onPing} />)
              : <div style={C.empty}>Nothing found yet. Search the world — look inside things, and what you turn up is written here.</div>}
          </div>
        </div>
      )}
    </>
  );
}
