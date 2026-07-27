'use client';

/**
 * The LIVE TABLE — the PLAYERS' screen. Joins a running :6984 DM-Lab session (in-memory; started from
 * the lab's Generate tab) and renders it with the real Phaser canvas: scenes appear on setScene, tokens
 * TWEEN when the world moves, rolls resolve inline.
 *
 * IT IS NOT A WORKBENCH (docs/PLAYER-INTERFACE.md P1). It fetches ONLY the player-safe projection
 * (/player-view, /player-turn) — never the DM-grade /view, which carries the campaign's intended ending,
 * NPC wants/fears, unfired plants and hidden tokens. Client-side hiding is not hiding: if it reaches this
 * page it has reached the players, so the filtering happens on the server and this page cannot even ask
 * for the secrets. Tool traces, state diffs and cost live on the :6984/dm/lab Run view instead.
 */

import { useEffect, useRef, useState } from 'react';
import SceneCanvas from '../play/SceneCanvas';
import SheetModal from './SheetModal';
import PartyDock from './PartyDock';
import BookDrawer from './BookDrawer';

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:6984';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Bubble {
  who: string;
  text: string;
  dm?: boolean;
  turn?: any; // the DmLabTurn for collapsibles (tools / diff / deltas / provenance)
}

const S = {
  rail: { display: 'flex', flexDirection: 'column', width: 430, minWidth: 340, borderLeft: '1px solid #23262f', background: '#12141a' } as React.CSSProperties,
  chip: { display: 'inline-block', background: '#1d2530', border: '1px solid #2b3542', borderRadius: 10, padding: '1px 8px', margin: '1px 3px 1px 0', fontSize: 11, color: '#8fb8e0' } as React.CSSProperties,
  btn: { background: '#c9a227', color: '#141414', border: 'none', borderRadius: 6, padding: '7px 14px', fontWeight: 600, cursor: 'pointer' } as React.CSSProperties,
};

/** The chapter breadcrumb — where the story HAS BEEN: ✓ closed · ● here. Only VISITED chapters exist
 *  in the player payload; unvisited titles are spoilers and never leave the server. */
function BeatStrip({ arc }: { arc: any }) {
  const beats = arc?.chapters ?? [];
  if (!beats.length) return null;
  const clocks: string[] = [];
  return (
    <div style={{ position: 'absolute', top: 34, left: 10, right: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', pointerEvents: 'none' }}>
      {beats.map((b: any) => (
        <span
          key={b.id}
          title={b.title}
          style={{
            fontSize: 11, padding: '2px 9px', borderRadius: 10, pointerEvents: 'auto',
            background: b.current ? '#c9a227' : '#1d2a1f',
            color: b.current ? '#141414' : '#7fb389',
            border: `1px solid ${b.current ? '#c9a227' : '#2a4630'}`,
            fontWeight: b.current ? 700 : 400,
          }}
        >
          {b.current ? '● ' : '✓ '}{b.title}
        </span>
      ))}
      {clocks.map((c: string, i: number) => (
        <span key={`c${i}`} style={{ fontSize: 11, padding: '2px 9px', borderRadius: 10, background: '#2a1d1d', color: '#d08f7f', border: '1px solid #422b2b' }}>⏱ {c}</span>
      ))}
    </div>
  );
}

export default function DmLiveTable() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [view, setView] = useState<any>(null); // the joined session's hydration payload
  const [sceneData, setSceneData] = useState<any>(null);
  const [deltas, setDeltas] = useState<any[] | null>(null);
  const [deltaNonce, setDeltaNonce] = useState(0);
  const [showRoofs, setShowRoofs] = useState(true);
  const [log, setLog] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [speaker, setSpeaker] = useState('');
  const [pendingRoll, setPendingRoll] = useState<any>(null);
  const [rollVal, setRollVal] = useState('');
  const [characters, setCharacters] = useState<any[]>([]);
  const [arc, setArc] = useState<any>(null);
  const [titleCard, setTitleCard] = useState<any>(null); // {title, outcome} — shown ~2.4s on a beat transition
  const [pings, setPings] = useState<string[] | null>(null); // story pings: narration-mentioned map ids
  const [pingNonce, setPingNonce] = useState(0);
  const [prologue, setPrologue] = useState<any>(null); // {premise, goal} — the WHY, shown once on join
  const [busy, setBusy] = useState(false);
  const [sheetId, setSheetId] = useState<string | null>(null); // which PC's sheet is open (P2)
  const [book, setBook] = useState<any>(null); // the Book: chapters, people met, findings (P3/P4)
  const [dossierId, setDossierId] = useState<string | null>(null); // an open NPC entry
  const sceneRev = useRef(0);
  const journalLenRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  // Session list + ?session= deep link.
  useEffect(() => {
    fetch(`${SERVER}/dm/lab/sessions`).then((r) => r.json()).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
    const id = new URLSearchParams(window.location.search).get('session');
    if (id) join(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the conversation only when the reader is already AT it. The 2s poll rebuilds this list on
  // every observed turn, so an unconditional scroll-to-bottom yanks anyone reading back through the log.
  const stickRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTo(0, el.scrollHeight);
  }, [log]);
  const onLogScroll = () => {
    const el = logRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // LIVE SYNC. The table is a SEPARATE page from the DM Lab, so a turn played in the lab used to reach
  // it never — it sat frozen at join time while the world moved on ("nothing moved" on screen even
  // though the engine had walked half the crowd). Poll a tiny {turnIndex, rev} stamp and re-hydrate only
  // when it actually changes: no map, no LLM, no cost per tick. Paused while hidden (a background tab
  // must not poll) and while THIS page has a turn in flight (submit() owns the update then).
  useEffect(() => {
    const id = view?.sessionId;
    if (!id) return;
    let stop = false;
    const tick = async () => {
      if (stop || busy || document.hidden) return;
      try {
        const r = await fetch(`${SERVER}/dm/lab/session/${id}/rev`);
        if (!r.ok) return;
        const s = await r.json();
        // journalLen matters: a chapter close or goal snapshot changes the Book without touching the
        // turn index or the scene revision, so those two alone would miss it.
        if (s.turnIndex === view.turnIndex && s.rev === sceneRev.current && (s.journalLen ?? 0) === journalLenRef.current) return;
        const v = await (await fetch(`${SERVER}/dm/lab/session/${id}/player-view`)).json();
        if (!stop) hydrate(v);
      } catch { /* a dropped poll must never break the table */ }
    };
    const h = setInterval(tick, 2000);
    document.addEventListener('visibilitychange', tick);
    return () => { stop = true; clearInterval(h); document.removeEventListener('visibilitychange', tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.sessionId, view?.turnIndex, busy]);

  async function join(id: string) {
    const res = await fetch(`${SERVER}/dm/lab/session/${id}/player-view`);
    if (!res.ok) {
      // Stale ?session= links are common after a server restart (sessions are in-memory only).
      history.replaceState(null, '', window.location.pathname);
      fetch(`${SERVER}/dm/lab/sessions`).then((r) => r.json()).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
      setLog([{ who: 'System', text: 'session not found — start one from the DM Lab Generate tab, or pick a running session below' }]);
      return;
    }
    const v = await res.json();
    hydrate(v, { fresh: true });
    history.replaceState(null, '', `?session=${id}`);
  }

  /** Adopt a full /view payload. Extracted from join() so the POLL can repair the WHOLE table — the map
   *  was never the only thing that went stale when a turn was played from the DM Lab; the transcript,
   *  turn counter, party HP, arc and cost all froze at join time too. */
  function hydrate(v: any, opts: { fresh?: boolean } = {}) {
    setView(v);
    if (opts.fresh) setSpeaker(v.party?.[0]?.name ?? 'player');
    setCharacters(v.characters ?? []);
    setArc(v.arc ?? null);
    setBook(v.book ?? null);
    // The prologue is generated fire-and-forget at create — if it lands while the YOUR STORY card is
    // still on screen showing the premise fallback, upgrade the card to the real opening page.
    if (v.book?.prologue) setPrologue((prev: any) => (prev && prev.premise !== v.book.prologue ? { ...prev, premise: v.book.prologue } : prev));
    journalLenRef.current = (v.book?.chapters ?? []).reduce((n: number, c: any) => n + (c.events?.length ?? 0), 0);
    setPendingRoll(v.pendingRoll ?? null);
    sceneRev.current = v.scene?.rev ?? 0;
    if (v.scene?.map) setSceneData(v.scene.map);
    // Rebuild the transcript from the session's rolling recent lines.
    setLog((v.recent ?? []).map((line: string) => {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      const who = m?.[1] ?? '—';
      return { who, text: m?.[2] ?? line, dm: who === 'Dungeon Master' };
    }));
    // THE WHY: on a fresh table (turn 0), show the campaign's purpose once — players should never
    // wonder "why are we here". Both fields come player-safe from the projection (no Director steering).
    if (opts.fresh && (v.turnIndex ?? 0) === 0 && (v.book?.prologue || v.arc?.premise || v.arc?.goal)) {
      setPrologue({ premise: v.book?.prologue ?? v.arc?.premise ?? '', goal: v.arc?.goal ?? '' });
    }
  }

  function applyScene(scene: any) {
    if (!scene) return;
    if (scene.changed && scene.map) {
      setSceneData(scene.map); // new reference → full render
    } else if (scene.deltas?.length) {
      if (scene.rev !== sceneRev.current + 1 && sceneRev.current !== 0 && scene.rev !== sceneRev.current) {
        // Revision gap (we missed something) → re-hydrate the full map instead of tweening a stale scene.
        fetch(`${SERVER}/dm/lab/session/${view.sessionId}/player-view`).then((r) => r.json()).then((v) => v.scene?.map && setSceneData(v.scene.map)).catch(() => {});
      } else {
        setDeltas(scene.deltas);
        setDeltaNonce((n) => n + 1);
      }
    }
    sceneRev.current = scene.rev ?? sceneRev.current;
  }

  async function submit(payload: any, echo?: Bubble) {
    if (!view || busy) return;
    if (echo) setLog((l) => [...l, echo]);
    setBusy(true);
    try {
      const res = await fetch(`${SERVER}/dm/lab/session/${view.sessionId}/player-turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await res.json();
      if (!res.ok) { setLog((l) => [...l, { who: 'System', text: d.error ?? 'turn failed' }]); return; }
      const t = d.turn;
      if (t.kind !== 'message' && !echo) setLog((l) => [...l, { who: 'roll', text: t.input }]);
      setLog((l) => [...l, { who: 'Dungeon Master', text: t.narration || '(awaiting your roll)', dm: true, turn: t }]);
      setPendingRoll(d.pendingRoll ?? null);
      setCharacters(d.characters ?? []);
      if (d.arc) setArc(d.arc);
      // The Book is always REPLACED by the authoritative array, never appended to — otherwise a poll
      // landing right after a submit would duplicate the turn's events.
      if (d.book) {
        setBook(d.book);
        journalLenRef.current = (d.book.chapters ?? []).reduce((n: number, c: any) => n + (c.events?.length ?? 0), 0);
      }
      if (t.beat) {
        // A beat transition landed: title card over the canvas while the new scene fades in.
        setTitleCard({ title: t.beat.title ?? t.beat.to, outcome: t.beat.outcome });
        setTimeout(() => setTitleCard(null), 2400);
      }
      applyScene(d.scene);
      if (t.mentions?.length) {
        // STORY PINGS after the map settles: pulse+label what the narration talked about.
        setPings(t.mentions);
        setTimeout(() => setPingNonce((n) => n + 1), t.deltas?.length ? 900 : 150);
      }
    } finally {
      setBusy(false);
      setRollVal('');
    }
  }

  function send() {
    const raw = input.trim();
    if (!raw) return;
    setInput('');
    submit({ say: raw, as: speaker }, { who: speaker, text: raw });
  }

  // ---------- render ----------
  if (!view) {
    return (
      <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: '#0d0b0a', color: '#e8e2d6' }}>
        <h1 style={{ fontFamily: 'ui-serif, Georgia, serif', color: '#c9a227', margin: 0 }}>MythWeaver — live table</h1>
        <p style={{ color: '#9a8f7d', maxWidth: 460, textAlign: 'center' }}>
          Join a running DM-Lab session. Start one from the <a href={`${SERVER}/dm/lab`} style={{ color: '#c9a227' }}>DM Lab</a> Generate tab, then pick it here.
        </p>
        {sessions.length === 0 ? (
          <p style={{ color: '#6b7080' }}>(no sessions running)</p>
        ) : (
          sessions.map((s) => (
            <button key={s.sessionId} style={S.btn} onClick={() => join(s.sessionId)}>
              {s.scenarioId} · turn {s.turnIndex} · {s.party?.map((p: any) => p.name).join(', ')}
            </button>
          ))
        )}
        {log.map((m, i) => <p key={i} style={{ color: '#b3542d' }}>{m.text}</p>)}
      </main>
    );
  }

  return (
    <main style={{ height: '100vh', display: 'flex', overflow: 'hidden', background: '#0d0b0a', color: '#e8e2d6' }}>
      {/* CANVAS — the animated table */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {/* PLAYER VIEW: camera locked close on the party (no pan / no zoom-out — real players never
            see the whole map), PC colour-rings + hover name-tags. The old freeCamera/fit inspector
            stays available on /play for the scene track. */}
        <SceneCanvas
          data={sceneData} playerView showRoofs={showRoofs} deltas={deltas} deltaNonce={deltaNonce} pings={pings} pingNonce={pingNonce}
          // Click a token: a PC opens their sheet, anyone the Book knows opens their entry.
          onInspect={(id: string) => {
            if (characters.some((c: any) => (c.id ?? c.name) === id)) { setSheetId(id); return; }
            const person = (book?.people ?? []).find((p: any) => p.id === id || p.name === (sceneData?.objects ?? []).find((o: any) => o.id === id)?.name);
            if (person) setDossierId(person.id);
          }}
        />
        <div style={{ position: 'absolute', top: 8, left: 10, display: 'flex', gap: 10, alignItems: 'center', fontSize: 12 }}>
          <span style={{ color: '#c9a227', fontFamily: 'ui-serif, Georgia, serif' }}>MythWeaver — live table</span>
        </div>
        {/* The party, ambient over the map — click a chip for the full sheet (P2). */}
        <PartyDock party={characters} onOpen={(id) => setSheetId(id)} />
        {/* THE BOOK (P4): what the party knows — chapters, people met, things found. */}
        <BookDrawer book={book} arc={arc} selected={dossierId} onSelect={setDossierId} />
        <div style={{ position: 'absolute', top: 8, right: 10, display: 'flex', gap: 8, fontSize: 12 }}>
          <label style={{ color: '#9a8f7d', cursor: 'pointer' }}>
            <input type="checkbox" checked={showRoofs} onChange={(e) => setShowRoofs(e.target.checked)} /> roofs
          </label>
        </div>
        {!sceneData && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#6b7080' }}>no scene yet — play a turn; the DM will set one</div>}
        <BeatStrip arc={arc} />
        {titleCard && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(8,7,6,0.72)', animation: 'mwfade 2.4s ease forwards', pointerEvents: 'none' }}>
            <div style={{ textAlign: 'center' }}>
              {titleCard.outcome && <div style={{ color: '#7a8494', fontSize: 13, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>{titleCard.outcome}</div>}
              <div style={{ color: '#c9a227', fontFamily: 'ui-serif, Georgia, serif', fontSize: 34 }}>{titleCard.title}</div>
            </div>
            <style>{'@keyframes mwfade { 0% {opacity: 0} 12% {opacity: 1} 78% {opacity: 1} 100% {opacity: 0} }'}</style>
          </div>
        )}
        {prologue && (
          // THE WHY — a one-time session prologue so players start knowing their purpose. Click to begin.
          <div onClick={() => setPrologue(null)} style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(8,7,6,0.86)', cursor: 'pointer', zIndex: 5 }}>
            <div style={{ maxWidth: 560, textAlign: 'center', padding: 24 }}>
              <div style={{ color: '#7a8494', fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', marginBottom: 14 }}>Your story</div>
              {prologue.premise && <div style={{ color: '#e8e2d6', fontFamily: 'ui-serif, Georgia, serif', fontSize: 17, lineHeight: 1.55, marginBottom: 18 }}>{prologue.premise}</div>}
              {prologue.goal && (
                <div style={{ borderTop: '1px solid #2a2620', paddingTop: 14 }}>
                  <span style={{ color: '#c9a227', fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', marginRight: 8 }}>Now</span>
                  <span style={{ color: '#cfc7b8', fontSize: 14 }}>{prologue.goal}</span>
                </div>
              )}
              <div style={{ color: '#6b6252', fontSize: 12, marginTop: 22 }}>click to take your places</div>
            </div>
          </div>
        )}
      </div>

      {/* RIGHT RAIL — transcript + controls (the workbench half) */}
      <div style={S.rail}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #23262f', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9a8f7d' }}>
          <span>{view.scenarioId} · turn {view.turnIndex}</span>
        </div>
        {/* transcript */}
        <div ref={logRef} onScroll={onLogScroll} style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {log.map((m, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: m.dm ? '#c9a227' : '#7a8494', marginBottom: 2 }}>{m.who}</div>
              <div style={{ fontSize: 13, lineHeight: 1.45, color: m.dm ? '#d9d2c3' : '#aab0bd', whiteSpace: 'pre-wrap' }}>{m.text}</div>
            </div>
          ))}
          {busy && <div style={{ color: '#6b7080', fontSize: 12 }}>DM thinking…</div>}
        </div>
        {/* roll bar */}
        {pendingRoll && (
          <div style={{ padding: '8px 12px', borderTop: '1px solid #23262f', background: '#1a1712', fontSize: 13 }}>
            🎲 <b>{pendingRoll.expr}</b> — {pendingRoll.reason}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input value={rollVal} onChange={(e) => setRollVal(e.target.value)} placeholder="total" style={{ width: 80 }} onKeyDown={(e) => e.key === 'Enter' && rollVal && submit({ roll: Number(rollVal) })} />
              <button style={S.btn} disabled={busy || !rollVal} onClick={() => submit({ roll: Number(rollVal) })}>declare</button>
              <button style={{ ...S.btn, background: '#2b3542', color: '#c9d4e0' }} disabled={busy} onClick={() => submit({ auto: true })}>auto-roll</button>
            </div>
          </div>
        )}
        {/* input */}
        <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid #23262f' }}>
          <select value={speaker} onChange={(e) => setSpeaker(e.target.value)} style={{ width: 110 }}>
            {(view.party ?? []).map((p: any) => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && !pendingRoll && send()}
            placeholder={pendingRoll ? 'resolve the roll above first' : 'What does the party do?'}
            disabled={busy || !!pendingRoll}
            style={{ flex: 1 }}
          />
          <button style={S.btn} onClick={send} disabled={busy || !!pendingRoll || !input.trim()}>Say</button>
        </div>
      </div>
      {/* The full character sheet, opened from a PartyDock chip (P2). Play continues behind it. */}
      {sheetId && <SheetModal pc={characters.find((c: any) => (c.id ?? c.name) === sheetId)} onClose={() => setSheetId(null)} />}
    </main>
  );
}
