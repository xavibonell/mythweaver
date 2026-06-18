'use client';

/**
 * Session player (docs/SCENE-CONTRACTS.md): one screen that RUNS a real DM session and
 * RENDERS it full-screen via <SceneCanvas>, which draws the server's frozen SceneMap. The
 * page owns the session/transcript UI; the canvas owns all of Phaser.
 */

import { useEffect, useState } from 'react';
import SceneCanvas from './SceneCanvas';

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:6984';

interface PartyMember {
  id: string;
  name: string;
  className: string;
}
interface LogLine {
  who: string;
  text: string;
  dm?: boolean;
}
interface RollReq {
  id: string;
  expr: string;
  reason: string;
}

export default function PlayPage() {
  const [sceneData, setSceneData] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [speaker, setSpeaker] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [input, setInput] = useState('');
  const [rollReq, setRollReq] = useState<RollReq | null>(null);
  const [cost, setCost] = useState(0);
  const [busy, setBusy] = useState(false);

  // Demo backdrop until the DM sets a scene.
  useEffect(() => {
    let cancelled = false;
    fetch(`${SERVER}/scene/demo`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && d && setSceneData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function applyResult(data: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (data.sceneMap) setSceneData(data.sceneMap); // the frozen SceneMap when a location is entered/established
    if (data.narration) setLog((l) => [...l, { who: 'Dungeon Master', text: data.narration, dm: true }]);
    setRollReq(data.rollRequest ?? null);
    if (typeof data.costUsd === 'number') setCost((c) => c + data.costUsd);
  }

  async function start() {
    setBusy(true);
    try {
      const res = await fetch(`${SERVER}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      setSessionId(data.sessionId);
      setParty(data.party ?? []);
      setSpeaker(data.party?.[0]?.name ?? 'Player');
      setLog([{ who: data.scenario.title, text: data.scenario.pitch, dm: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const raw = input.trim();
    if (!sessionId || !raw) return;
    setInput('');
    setBusy(true);
    try {
      let body: Record<string, unknown>;
      if (rollReq) {
        const total = Number(raw);
        if (Number.isNaN(total)) {
          setLog((l) => [...l, { who: 'System', text: 'Enter your dice total as a number.' }]);
          return;
        }
        setLog((l) => [...l, { who: speaker, text: `🎲 ${total}` }]);
        body = { rollRequestId: rollReq.id, total };
      } else {
        setLog((l) => [...l, { who: speaker, text: raw }]);
        body = { speakerId: speaker, text: raw };
      }
      const res = await fetch(`${SERVER}/sessions/${sessionId}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      applyResult(await res.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{ padding: '6px 12px', color: '#c9a227', fontFamily: 'ui-serif, Georgia, serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: '0 0 auto' }}
      >
        <span>MythWeaver — live session</span>
        <span style={{ color: '#9a8f7d', fontSize: '0.8rem' }}>
          <a href="/lab" style={{ color: '#9a8f7d', marginRight: 12 }}>
            Scene Lab →
          </a>
          {sessionId ? `model spend $${cost.toFixed(4)}` : ''}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, background: '#0d0b0a' }}>
        <SceneCanvas data={sceneData} />
      </div>

      <div style={{ height: '32vh', display: 'flex', flexDirection: 'column', borderTop: '1px solid #2a241f', background: '#1e1a17', flex: '0 0 auto' }}>
        {!sessionId ? (
          <div style={{ padding: 16 }}>
            <button onClick={start} disabled={busy}>
              {busy ? 'Summoning the DM…' : 'Begin the adventure'}
            </button>
            <p style={{ color: '#9a8f7d', marginTop: 8 }}>The map above is a demo backdrop until the DM sets the scene.</p>
          </div>
        ) : (
          <>
            <div className="log" style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {log.map((m, i) => (
                <div key={i} className={`msg${m.dm ? ' dm' : ''}`}>
                  <span className="who">{m.who}</span>
                  {m.text}
                </div>
              ))}
            </div>
            {rollReq && (
              <div className="roll" style={{ margin: '0 12px' }}>
                🎲 Roll <strong>{rollReq.expr}</strong> — {rollReq.reason}. Type your total below.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, padding: 12, alignItems: 'center', borderTop: '1px solid #2a241f' }}>
              <select value={speaker} onChange={(e) => setSpeaker(e.target.value)} aria-label="Active character">
                {party.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name} ({p.className})
                  </option>
                ))}
              </select>
              <input
                value={input}
                placeholder={rollReq ? `Enter your ${rollReq.expr} total…` : 'What do you do?'}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && send()}
                disabled={busy}
                style={{ flex: 1 }}
              />
              <button onClick={send} disabled={busy || !input.trim()}>
                {busy ? '…' : rollReq ? 'Submit roll' : 'Say'}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
