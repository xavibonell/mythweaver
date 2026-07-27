'use client';

/**
 * THE BOOK (docs/PLAYER-INTERFACE.md P4) — what the party knows, on the table.
 *
 * A bookmark spine on the left edge; clicking one slides a panel out OVER the canvas. Deliberately
 * NON-MODAL and closed only by an explicit click: at a real table one player reads while another acts,
 * so a click-outside-to-close drawer would slam shut every time someone else touched the map.
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const ICON: Record<string, string> = {
  chapter: '📕', goal: '🎯', place: '📍', verdict: '›', disposition: '💬', finding: '🔍', loot: '🎒', decision: '◆',
};

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

function EventRow({ e }: { e: any }) {
  return (
    <div style={C.row}>
      <span style={{ flex: '0 0 auto', width: 15 }}>{ICON[e.kind] ?? '·'}</span>
      <span style={{ flex: 1 }}>{e.text}</span>
      <span style={{ ...C.sub, flex: '0 0 auto' }}>t{e.turn}</span>
    </div>
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

export default function BookDrawer({ book, arc, selected, onSelect }: { book: any; arc: any; selected: string | null; onSelect: (id: string | null) => void }) {
  const [tab, setTab] = useState<TabKey | null>(null);
  const chapters: any[] = book?.chapters ?? [];
  const people: any[] = book?.people ?? [];
  const findings: any[] = book?.findings ?? [];
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
        {TABS.map((t) => {
          const on = openTab === t.key;
          return (
            <button
              key={t.key}
              title={t.label}
              onClick={() => { if (on) { setTab(null); onSelect(null); } else { setTab(t.key); if (t.key !== 'people') onSelect(null); } }}
              style={C.tab(on)}
            >
              <span>{t.mark}</span>
              <span style={C.count(on)}>{counts[t.key] || ''}</span>
            </button>
          );
        })}
      </div>

      {openTab && (
        // stopPropagation keeps clicks/scrolls off the Phaser canvas underneath.
        <div style={C.drawer} onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
          <div style={C.head}>
            <span style={{ fontFamily: 'ui-serif, Georgia, serif', color: '#c9a227', fontSize: 14 }}>
              {dossier ? dossier.name : TABS.find((t) => t.key === openTab)!.label}
            </span>
            <button
              onClick={() => (dossier ? onSelect(null) : (setTab(null), onSelect(null)))}
              style={{ background: 'transparent', border: '1px solid #2b3542', color: '#9aa0b0', borderRadius: 5, padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
            >
              {dossier ? '‹ back' : '✕'}
            </button>
          </div>

          {/* All three panels stay mounted; only display toggles (see the header note). */}
          <div style={{ ...C.body, display: openTab === 'journal' ? 'block' : 'none' }}>
            {arc?.premise && <div style={{ fontSize: 12, lineHeight: 1.6, color: '#c3c8d4', paddingBottom: 8, borderBottom: '1px solid #1d2027' }}>{arc.premise}</div>}
            {arc?.goal && <div style={{ ...C.row, color: '#c9a227', marginTop: 8 }}><span>🎯</span><span>{arc.goal}</span></div>}
            {!counts.journal && <div style={{ ...C.empty, marginTop: 12 }}>Nothing recorded yet — what you discover, decide and survive lands here.</div>}
            {chapters.map((c) => (
              <div key={c.beatId}>
                <div style={C.chapTitle}>{c.current ? '● ' : '✓ '}{c.title}{c.outcome ? <span style={C.sub}> — {c.outcome}</span> : null}</div>
                {c.goal && <div style={{ ...C.sub, fontStyle: 'italic', marginBottom: 3 }}>Goal: {c.goal}</div>}
                {(c.events ?? []).map((e: any) => <EventRow key={e.seq} e={e} />)}
              </div>
            ))}
          </div>

          <div style={{ ...C.body, display: openTab === 'people' ? 'block' : 'none' }}>
            {dossier ? (
              <div>
                <div style={C.sub}>
                  First met turn {dossier.firstSeen?.turn} · last seen turn {dossier.lastSeen?.turn}
                </div>
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
                  <button key={p.id} onClick={() => onSelect(p.id)} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', background: 'transparent', border: 'none', borderBottom: '1px solid #16181e', color: '#d8dbe2', padding: '8px 2px', cursor: 'pointer', textAlign: 'left' }}>
                    <span style={{ fontSize: 13 }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: r.color }}>{r.word} ›</span>
                  </button>
                );
              })
            ) : <div style={C.empty}>No one yet. People you meet take their place here.</div>}
          </div>

          <div style={{ ...C.body, display: openTab === 'findings' ? 'block' : 'none' }}>
            {findings.length
              ? findings.map((f: any) => <EventRow key={f.seq} e={f} />)
              : <div style={C.empty}>Nothing found yet. Search the world — look inside things, and what you turn up is written here.</div>}
          </div>
        </div>
      )}
    </>
  );
}
