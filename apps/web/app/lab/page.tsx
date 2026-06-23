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
  // The build MODE (one selector, mutually exclusive — replaces the old look-alike checkboxes):
  //  primitives = G1b LLM-composes-a-program (the new path, default) · classic = old DM→Director→3-grammar
  //  pipeline · city = district stitcher · large = classic but floored to a big grid (perf/zoom test).
  const [mode, setMode] = useState<'primitives' | 'classic' | 'city' | 'large' | 'component'>('primitives');
  const [cityCount, setCityCount] = useState(6); // number of districts to stitch (city mode)
  const [fitNonce, setFitNonce] = useState(0); // bump to re-frame the whole scene in the free camera
  // Component mode — a contact sheet of N seed-varied instances of ONE micro-generator, for isolated
  // iteration. Mirrors COMPONENT_KINDS on the server (packages/scene/src/component-lab.ts).
  const COMPONENT_KINDS = ['building:tavern', 'building:temple', 'building:smithy', 'building:shop', 'building:house', 'building:inn', 'building:general_store', 'building:cathedral', 'building:jail', 'building:vault', 'building:keep', 'building:library', 'building:armory', 'building:barracks', 'building:guildhall', 'building:goblin_warren', 'building:manor', 'shape:rect', 'shape:ell', 'shape:tee', 'shape:you', 'shape:plus', 'shape:compose', 'shape:compose:temple', 'shape:compose:tavern', 'shape:compose:smithy', 'shape:compose:shop', 'vignette:market', 'vignette:forge', 'vignette:shrine', 'vignette:well', 'vignette:camp', 'vignette:graveyard', 'plaza', 'streets', 'density:trees', 'density:flowers', 'density:furniture', 'clearing', 'cave', 'rooms', 'maze'];
  const [componentKind, setComponentKind] = useState('building:tavern');
  const [componentCount, setComponentCount] = useState(6);
  const [componentSeed, setComponentSeed] = useState(1);
  const prog = mode === 'primitives';
  const city = mode === 'city';
  const large = mode === 'large';
  const component = mode === 'component';

  // City build — district stitcher. Empty brief → deterministic roster ($0). A brief in the box →
  // the V3 macro planner designs the districts (one LLM call), then the same deterministic stitcher.
  async function buildCity() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const b = brief.trim();
      const res = await fetch(`${SERVER}/scene/city`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: cityCount, ...(b ? { brief: b } : {}) }) });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `error ${res.status}`);
      else {
        setResult(data);
        setEstablishEdit(JSON.stringify(data.establish, null, 2));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // G1 spike — render a hand-written GOLD composition (deterministic, no DM/LLM) to prove the new
  // primitive vocabulary expresses diverse scenes (maze / lake / city / crypt) from one system.
  async function buildSpike(name: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${SERVER}/scene/spike`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `error ${res.status}`);
      else {
        setResult(data);
        setEstablishEdit(JSON.stringify(data.establish, null, 2));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // G1b — the creativity test: the LLM composes a primitive PROGRAM from the brief (no templates).
  async function buildProgram(text?: string) {
    const b = (text ?? brief).trim();
    if (text) setBrief(text);
    if (!b || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${SERVER}/scene/program`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief: b }) });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `error ${res.status}`);
      else {
        setResult(data);
        setEstablishEdit(JSON.stringify(data.establish, null, 2));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Component contact sheet — N seed-varied instances of one micro-generator, tiled. Deterministic ($0).
  async function buildComponent(seedOverride?: number) {
    if (busy) return;
    const seed = seedOverride ?? componentSeed;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${SERVER}/scene/component`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: componentKind, count: componentCount, seed }) });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? `error ${res.status}`);
      else {
        setResult(data);
        setEstablishEdit(JSON.stringify(data.establish, null, 2));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function build(text?: string) {
    if (prog) return buildProgram(text);
    if (city) return buildCity();
    if (component) return buildComponent();
    const b = (text ?? brief).trim();
    if (!b || busy) return;
    if (text) setBrief(text);
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${SERVER}/scene/lab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief: b, large }) });
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
        <SceneCanvas data={m ?? null} freeCamera fitNonce={fitNonce} />
        {m && (
          <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(13,11,10,0.7)', padding: '4px 8px', borderRadius: 6, fontSize: '0.78rem', color: '#b8ad99' }}>
            <span style={{ opacity: 0.7 }}>drag = pan · wheel = zoom</span>
            <button onClick={() => setFitNonce((n) => n + 1)} style={{ fontSize: '0.78rem', padding: '2px 8px', background: '#241f1a', color: '#c9a227', border: '1px solid #2a241f', borderRadius: 4, cursor: 'pointer' }}>
              Fit
            </button>
          </div>
        )}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'stretch', minWidth: 150 }}>
            <button onClick={() => build()} disabled={busy || (!city && !component && !brief.trim())} style={{ flex: 1, minWidth: 140 }}>
              {busy ? 'Building…' : prog ? 'Compose scene' : city ? 'Build city' : component ? 'Build sheet' : 'Build scene'}
            </button>
            <div style={{ fontSize: '0.66rem', color: '#7c7464', marginTop: 2 }}>Mode:</div>
            {([
              ['primitives', 'Primitives', 'NEW — the LLM composes a primitive program from your brief (no templates). The generation path we are building.'],
              ['classic', 'Classic', 'OLD — DM → Director → the 3 fixed grammars (town/interior/outdoor). Being replaced.'],
              ['city', 'City', 'District stitcher. Empty box = sample roster ($0); a brief = the planner designs districts.'],
              ['large', 'Large (classic)', 'Classic pipeline floored to a big grid — a perf/zoom test, not a new layout.'],
              ['component', 'Component', 'Contact sheet of N seed-varied instances of ONE micro-generator (a building, vignette, density, street, plaza…) — iterate a component in isolation. $0.'],
            ] as const).map(([val, label, tip]) => (
              <label key={val} title={tip} style={{ fontSize: '0.72rem', color: mode === val ? '#e8dfce' : '#9a8f7d', display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}>
                <input type="radio" name="lab-mode" checked={mode === val} onChange={() => setMode(val)} />
                {label}
                {val === 'city' && mode === 'city' && (
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={cityCount}
                    onChange={(e) => setCityCount(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
                    style={{ width: 44, marginLeft: 2, background: '#15120f', color: '#e8dfce', border: '1px solid #2a241f', borderRadius: 3, padding: '1px 4px' }}
                    title="number of districts"
                  />
                )}
              </label>
            ))}
            {component && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4, borderTop: '1px solid #2a241f', paddingTop: 4 }}>
                <select value={componentKind} onChange={(e) => setComponentKind(e.target.value)} style={{ fontSize: '0.72rem', background: '#15120f', color: '#e8dfce', border: '1px solid #2a241f', borderRadius: 3, padding: '2px 4px' }}>
                  {COMPONENT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: '0.7rem', color: '#9a8f7d' }}>
                  <span>×</span>
                  <input type="number" min={1} max={12} value={componentCount} onChange={(e) => setComponentCount(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} style={{ width: 40, background: '#15120f', color: '#e8dfce', border: '1px solid #2a241f', borderRadius: 3, padding: '1px 4px' }} title="instances" />
                  <button onClick={() => { const s = componentSeed + 1; setComponentSeed(s); buildComponent(s); }} disabled={busy} style={{ fontSize: '0.7rem', padding: '1px 8px', background: '#241f1a', color: '#c9a227', border: '1px solid #2a241f', borderRadius: 3, cursor: 'pointer' }} title="reshuffle (new seed)">
                    ↻ reshuffle
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: '0.72rem', color: '#7c7464' }}>G1 spike (primitive vocab):</span>
          {['labyrinth', 'lake', 'city', 'town', 'crypt'].map((n) => (
            <button key={n} onClick={() => buildSpike(n)} disabled={busy} style={{ fontSize: '0.72rem', padding: '3px 10px', background: '#1f2a1a', color: '#a9c98a', border: '1px solid #2a341f', borderRadius: 4, cursor: 'pointer' }}>
              ▣ {n}
            </button>
          ))}
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
            {result.program && <Artifact title="0 · Scene program (the primitives the LLM composed)" value={result.program} />}
            <Artifact title="2 · SceneComposition (Director layout)" value={result.composition} />
            <Artifact title="3 · SceneMap.objects (frozen placement)" value={result.sceneMap?.objects} />
          </div>
        )}
      </div>
    </main>
  );
}
