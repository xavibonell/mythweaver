'use client';

import { useState } from 'react';

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

export default function Page() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [speaker, setSpeaker] = useState('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [input, setInput] = useState('');
  const [rollReq, setRollReq] = useState<RollReq | null>(null);
  const [cost, setCost] = useState(0);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const res = await fetch(`${SERVER}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setSessionId(data.sessionId);
      setParty(data.party ?? []);
      setSpeaker(data.party?.[0]?.name ?? 'Player');
      setLog([{ who: data.scenario.title, text: data.scenario.pitch, dm: true }]);
    } finally {
      setBusy(false);
    }
  }

  function applyResult(data: { narration?: string; rollRequest?: RollReq; costUsd?: number }) {
    if (data.narration) setLog((l) => [...l, { who: 'Dungeon Master', text: data.narration!, dm: true }]);
    setRollReq(data.rollRequest ?? null);
    if (typeof data.costUsd === 'number') setCost((c) => c + data.costUsd!);
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
      const res = await fetch(`${SERVER}/sessions/${sessionId}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      applyResult(await res.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <h1>MythWeaver</h1>
      <p className="sub">An AI Dungeon Master · D&amp;D 5e (SRD) · text-first preview</p>

      {!sessionId ? (
        <button onClick={start} disabled={busy}>
          {busy ? 'Summoning the DM…' : 'Begin the adventure'}
        </button>
      ) : (
        <>
          <div className="log">
            {log.map((m, i) => (
              <div key={i} className={`msg${m.dm ? ' dm' : ''}`}>
                <span className="who">{m.who}</span>
                {m.text}
              </div>
            ))}
          </div>
          {rollReq && (
            <div className="roll">
              🎲 Roll <strong>{rollReq.expr}</strong> — {rollReq.reason}. Type your total below.
            </div>
          )}
          <p className="cost">Session model spend: ${cost.toFixed(4)}</p>

          <div className="bar">
            <div className="bar-inner">
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
              />
              <button onClick={send} disabled={busy || !input.trim()}>
                {busy ? '…' : rollReq ? 'Submit roll' : 'Say'}
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
