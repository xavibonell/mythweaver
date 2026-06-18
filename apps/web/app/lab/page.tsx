'use client';

/**
 * Scene Lab — the pipeline test bench. Type a scene brief; the real DM imagines it (setScene),
 * the Director composes it, the Cartographer freezes a SceneMap, and it renders here — with the
 * EstablishScene + SceneComposition artifacts shown so you can see WHERE a bad result came from
 * (DM fiction vs Director layout vs art coverage). No game session; iterate fast.
 */

import { useState } from 'react';
import SceneCanvas from '../play/SceneCanvas';

const SERVER = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:6984';

const EXAMPLES = [
  'A misty fen-village green at dusk: reed huts, a well, a cold fire-pit, black water beyond. A wary fisherwoman waits; a shape lurks in the reeds.',
  'A torchlit crypt antechamber: stone sarcophagi, broken pillars, a hanging banner, an archway to the dark. Two skeletons stand guard.',
  'A bustling market square at midday: stalls, crates and barrels, a blacksmith’s forge. A merchant, a guard, and a hooded stranger.',
  'A forest clearing at night around a bonfire: tall pines, a fallen log, scattered rocks. A lone ranger keeps watch.',
];

/* eslint-disable @typescript-eslint/no-explicit-any */
interface LabResult {
  brief: string;
  establish: any;
  composition: any;
  sceneMap: any;
  narration: string;
  model: string;
}

function Artifact({ title, value }: { title: string; value: any }) {
  return (
    <details style={{ border: '1px solid #2a241f', borderRadius: 4, marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', padding: '6px 10px', color: '#c9a227', fontSize: '0.85rem' }}>{title}</summary>
      <pre style={{ margin: 0, padding: 10, maxHeight: 220, overflow: 'auto', fontSize: '0.72rem', color: '#cdc4b4', background: '#15120f' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export default function LabPage() {
  const [brief, setBrief] = useState('');
  const [result, setResult] = useState<LabResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Editable EstablishScene for Director-isolation mode: tweak the DM's output (or paste your own)
  // and re-run ONLY the Director + Cartographer, with no DM in the loop.
  const [establishEdit, setEstablishEdit] = useState('');

  async function build(text?: string) {
    const b = (text ?? brief).trim();
    if (!b || busy) return;
    if (text) setBrief(text);
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${SERVER}/scene/lab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief: b }) });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `error ${res.status}`);
      } else {
        setResult(data);
        setEstablishEdit(JSON.stringify(data.establish, null, 2));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Director-only: skip the DM, compose the (edited) EstablishScene directly. The brief box is sent
  // as the layout directive so the Director still sees the spatial intent.
  async function composeOnly() {
    if (busy) return;
    let establish: unknown;
    try {
      establish = JSON.parse(establishEdit);
    } catch {
      setError('EstablishScene is not valid JSON');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${SERVER}/scene/lab/compose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ establish, directive: brief.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `error ${res.status}`);
      else setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const m = result?.sceneMap;
  const summary = m
    ? `${m.locationId} · ${m.biome}/${m.lighting} · ${m.grammar} · ${m.grid.cols}×${m.grid.rows} · ${m.objects.length} objects · ${m.ambiance.length} ambiance`
    : '';

  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '6px 12px', color: '#c9a227', fontFamily: 'ui-serif, Georgia, serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flex: '0 0 auto' }}>
        <span>MythWeaver — Scene Lab</span>
        <span style={{ fontSize: '0.8rem' }}>
          <a href="/play" style={{ color: '#9a8f7d' }}>
            ← Live session
          </a>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, background: '#0d0b0a', position: 'relative' }}>
        <SceneCanvas data={m ?? null} />
        {!m && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5c544a', pointerEvents: 'none' }}>
            {busy ? 'The DM is imagining the scene…' : 'Describe a place below and build it.'}
          </div>
        )}
      </div>

      <div style={{ height: '40vh', display: 'flex', flexDirection: 'column', borderTop: '1px solid #2a241f', background: '#1e1a17', flex: '0 0 auto', overflow: 'auto', padding: 12 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea
            value={brief}
            placeholder="Describe a scene for the DM to build… (terrain, structures, mood, who is present)"
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) build();
            }}
            rows={3}
            style={{ flex: 1, resize: 'vertical', background: '#15120f', color: '#e8dfce', border: '1px solid #2a241f', borderRadius: 4, padding: 8, fontFamily: 'inherit' }}
          />
          <button onClick={() => build()} disabled={busy || !brief.trim()} style={{ alignSelf: 'stretch', minWidth: 120 }}>
            {busy ? 'Building…' : 'Build scene'}
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {EXAMPLES.map((ex, i) => (
            <button key={i} onClick={() => build(ex)} disabled={busy} style={{ fontSize: '0.72rem', padding: '3px 8px', background: '#241f1a', color: '#b8ad99', border: '1px solid #2a241f', borderRadius: 4, cursor: 'pointer', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ex}
            </button>
          ))}
        </div>

        {error && <p style={{ color: '#d98b8b', marginTop: 8 }}>⚠ {error}</p>}

        {result && (
          <div style={{ marginTop: 10 }}>
            <p style={{ color: '#e8dfce', fontStyle: 'italic', margin: '0 0 4px' }}>“{result.narration}”</p>
            <p style={{ color: '#7c7464', fontSize: '0.72rem', margin: 0, fontFamily: 'monospace' }}>
              {summary} · {result.model}
            </p>
            <details style={{ border: '1px solid #2a241f', borderRadius: 4, marginTop: 8 }} open>
              <summary style={{ cursor: 'pointer', padding: '6px 10px', color: '#c9a227', fontSize: '0.85rem' }}>
                1 · EstablishScene (DM fiction) — editable · Director-only
              </summary>
              <div style={{ padding: 10 }}>
                <p style={{ margin: '0 0 6px', color: '#7c7464', fontSize: '0.72rem' }}>
                  Edit this and run the Director alone (no DM) — isolates layout from DM fiction. The brief box above is sent as the layout directive.
                </p>
                <textarea
                  value={establishEdit}
                  onChange={(e) => setEstablishEdit(e.target.value)}
                  spellCheck={false}
                  rows={10}
                  style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box', background: '#15120f', color: '#cdc4b4', border: '1px solid #2a241f', borderRadius: 4, padding: 8, fontFamily: 'monospace', fontSize: '0.72rem' }}
                />
                <button onClick={composeOnly} disabled={busy} style={{ marginTop: 6 }}>
                  {busy ? 'Composing…' : 'Run Director only ▸'}
                </button>
              </div>
            </details>
            <Artifact title="2 · SceneComposition (Director layout)" value={result.composition} />
            <Artifact title="3 · SceneMap.objects (frozen placement)" value={result.sceneMap?.objects} />
          </div>
        )}
      </div>
    </main>
  );
}
