'use client';

/**
 * The LIVE TABLE — the DM Lab's animated play surface. Joins a running :6984 DM-Lab session
 * (in-memory; started from the lab's Generate tab) and renders it with the real Phaser canvas:
 * scenes appear on setScene, tokens TWEEN when the DM moves the world (updateScene / combat sync),
 * rolls resolve inline. A workbench, not a game UI: tools, state Δ, scene Δ and cost stay visible.
 *
 * The :6984/dm/lab page remains the authoring surface (Generate / Arc / Playbook / Distill) and the
 * low-fi fallback Run view; this page is purely additive on the same session API (CORS-open).
 */

import { useEffect, useRef, useState } from 'react';
import SceneCanvas from '../play/SceneCanvas';

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

/** The arc's beat stepper — where the story IS: ✓ done · ● here · → reachable. Clocks = pressure. */
function BeatStrip({ arc }: { arc: any }) {
  const beats = arc?.beats ?? [];
  if (!beats.length) return null;
  const clocks = arc?.brief?.clocks ?? [];
  return (
    <div style={{ position: 'absolute', top: 34, left: 10, right: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', pointerEvents: 'none' }}>
      {beats.map((b: any) => (
        <span
          key={b.id}
          title={b.title}
          style={{
            fontSize: 11, padding: '2px 9px', borderRadius: 10, pointerEvents: 'auto',
            background: b.current ? '#c9a227' : b.done ? '#1d2a1f' : '#14161c',
            color: b.current ? '#141414' : b.done ? '#7fb389' : b.reachable ? '#8fb8e0' : '#565b66',
            border: `1px solid ${b.current ? '#c9a227' : b.done ? '#2a4630' : b.reachable ? '#2b3542' : '#1d2027'}`,
            fontWeight: b.current ? 700 : 400,
          }}
        >
          {b.done ? '✓ ' : b.current ? '● ' : b.reachable ? '→ ' : ''}{b.title}
        </span>
      ))}
      {clocks.map((c: string, i: number) => (
        <span key={`c${i}`} style={{ fontSize: 11, padding: '2px 9px', borderRadius: 10, background: '#2a1d1d', color: '#d08f7f', border: '1px solid #422b2b' }}>⏱ {c}</span>
      ))}
    </div>
  );
}

function DeltaChips({ deltas }: { deltas: any[] }) {
  if (!deltas?.length) return null;
  return (
    <div style={{ margin: '3px 0' }}>
      {deltas.map((d, i) => (
        <span key={i} style={S.chip}>
          Δ {d.op === 'move' ? `${d.id} → ${d.to.col},${d.to.row}` : d.op === 'spawn' ? `+ ${d.name || d.id}${d.at ? ` @ ${d.at.col},${d.at.row}` : ''}` : d.op === 'despawn' ? `− ${d.id}` : `${d.op} ${d.id}`}
        </span>
      ))}
    </div>
  );
}

function TurnDetails({ turn }: { turn: any }) {
  const tools = turn?.tools ?? [];
  const diff = turn?.diff ?? [];
  const p = turn?.sceneProvenance;
  if (!tools.length && !diff.length && !p) return null;
  return (
    <details style={{ marginTop: 4 }}>
      <summary style={{ cursor: 'pointer', color: '#6b7080', fontSize: 11 }}>
        {tools.length} tool(s) · {diff.length} state Δ{p ? ` · scene: ${p.engine}` : ''}
      </summary>
      <div style={{ fontSize: 11, color: '#9aa0b0', marginTop: 4 }}>
        {tools.map((t: any, i: number) => (
          <div key={i} style={{ margin: '2px 0', wordBreak: 'break-word' }}>
            <span style={{ color: '#c9a227' }}>{t.name}</span>
            <span style={{ color: '#565b66' }}>({JSON.stringify(t.input).slice(0, 220)})</span>
            {t.result ? <span style={{ color: '#7a8494' }}> → {String(t.result).slice(0, 200)}</span> : null}
          </div>
        ))}
        {diff.length > 0 && <div style={{ marginTop: 3, color: '#8fb8e0' }}>state Δ: {diff.join(' | ')}</div>}
        {p?.enrichedBrief && (
          <div style={{ marginTop: 3 }}>
            <b style={{ color: '#c9a227' }}>brief → generator:</b>
            <pre style={{ whiteSpace: 'pre-wrap', background: '#0b0c10', padding: 6, borderRadius: 4, maxHeight: 120, overflow: 'auto' }}>{p.enrichedBrief}</pre>
            {p.moodText ? <div>mood: “{p.moodText.slice(0, 120)}” → <b>{p.program?.lighting}</b> ({p.lightingReason})</div> : null}
            {p.program?.notes?.length ? <div>interventions: {p.program.notes.join(' · ')}</div> : null}
          </div>
        )}
      </div>
    </details>
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
  const [cost, setCost] = useState(0);
  const [busy, setBusy] = useState(false);
  const sceneRev = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  // Session list + ?session= deep link.
  useEffect(() => {
    fetch(`${SERVER}/dm/lab/sessions`).then((r) => r.json()).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
    const id = new URLSearchParams(window.location.search).get('session');
    if (id) join(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log]);

  async function join(id: string) {
    const res = await fetch(`${SERVER}/dm/lab/session/${id}/view`);
    if (!res.ok) {
      // Stale ?session= links are common after a server restart (sessions are in-memory only).
      history.replaceState(null, '', window.location.pathname);
      fetch(`${SERVER}/dm/lab/sessions`).then((r) => r.json()).then((d) => setSessions(d.sessions ?? [])).catch(() => {});
      setLog([{ who: 'System', text: 'session not found — start one from the DM Lab Generate tab, or pick a running session below' }]);
      return;
    }
    const v = await res.json();
    setView(v);
    setSpeaker(v.party?.[0]?.name ?? 'player');
    setCharacters(v.characters ?? []);
    setArc(v.arc ?? null);
    setPendingRoll(v.pendingRoll ?? null);
    setCost(v.totalCostUsd ?? 0);
    sceneRev.current = v.scene?.rev ?? 0;
    if (v.scene?.map) setSceneData(v.scene.map);
    // Rebuild the transcript from the session's rolling recent lines.
    setLog((v.recent ?? []).map((line: string) => {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      const who = m?.[1] ?? '—';
      return { who, text: m?.[2] ?? line, dm: who === 'Dungeon Master' };
    }));
    history.replaceState(null, '', `?session=${id}`);
  }

  function applyScene(scene: any) {
    if (!scene) return;
    if (scene.changed && scene.map) {
      setSceneData(scene.map); // new reference → full render
    } else if (scene.deltas?.length) {
      if (scene.rev !== sceneRev.current + 1 && sceneRev.current !== 0 && scene.rev !== sceneRev.current) {
        // Revision gap (we missed something) → re-hydrate the full map instead of tweening a stale scene.
        fetch(`${SERVER}/dm/lab/session/${view.sessionId}/view`).then((r) => r.json()).then((v) => v.scene?.map && setSceneData(v.scene.map)).catch(() => {});
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
      const res = await fetch(`${SERVER}/dm/lab/session/${view.sessionId}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await res.json();
      if (!res.ok) { setLog((l) => [...l, { who: 'System', text: d.error ?? 'turn failed' }]); return; }
      const t = d.turn;
      if (t.kind !== 'message' && !echo) setLog((l) => [...l, { who: 'roll', text: t.input }]);
      setLog((l) => [...l, { who: 'Dungeon Master', text: t.narration || '(awaiting your roll)', dm: true, turn: t }]);
      setPendingRoll(d.pendingRoll ?? null);
      setCharacters(d.characters ?? []);
      if (d.arc) setArc(d.arc);
      setCost(d.totalCostUsd ?? 0);
      if (t.beat) {
        // A beat transition landed: title card over the canvas while the new scene fades in.
        setTitleCard({ title: t.beat.title ?? t.beat.to, outcome: t.beat.outcome });
        setTimeout(() => setTitleCard(null), 2400);
      }
      applyScene(d.scene);
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
              {s.scenarioId} · turn {s.turnIndex} · {s.party?.map((p: any) => p.name).join(', ')} · {s.sceneEngine}
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
        <SceneCanvas data={sceneData} playerView showRoofs={showRoofs} deltas={deltas} deltaNonce={deltaNonce} />
        <div style={{ position: 'absolute', top: 8, left: 10, display: 'flex', gap: 10, alignItems: 'center', fontSize: 12 }}>
          <span style={{ color: '#c9a227', fontFamily: 'ui-serif, Georgia, serif' }}>MythWeaver — live table</span>
          <span style={{ background: view.sceneEngine === 'modern' ? '#3fa34d' : '#6b7080', color: '#0b0c10', borderRadius: 3, padding: '1px 6px', fontWeight: 600 }}>{view.sceneEngine}</span>
        </div>
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
      </div>

      {/* RIGHT RAIL — transcript + controls (the workbench half) */}
      <div style={S.rail}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid #23262f', display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9a8f7d' }}>
          <span>{view.scenarioId} · turn {view.turnIndex}</span>
          <span style={{ fontFamily: 'ui-monospace, monospace' }}>${cost.toFixed(3)}</span>
        </div>
        {/* party HP rows */}
        <div style={{ padding: '6px 12px', borderBottom: '1px solid #23262f', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {characters.map((c: any) => (
            <span key={c.id ?? c.name} style={{ fontSize: 12, color: '#9aa0b0' }}>
              <b style={{ color: '#e8e2d6' }}>{c.name}</b>{' '}
              <span style={{ color: (c.hp?.cur ?? 1) <= (c.hp?.max ?? 1) / 3 ? '#b3542d' : '#3fa34d' }}>{c.hp?.cur}/{c.hp?.max}</span>
            </span>
          ))}
        </div>
        {/* transcript */}
        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {log.map((m, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: m.dm ? '#c9a227' : '#7a8494', marginBottom: 2 }}>{m.who}</div>
              <div style={{ fontSize: 13, lineHeight: 1.45, color: m.dm ? '#d9d2c3' : '#aab0bd', whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {m.turn && <DeltaChips deltas={m.turn.deltas ?? []} />}
              {m.turn && <TurnDetails turn={m.turn} />}
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
    </main>
  );
}
