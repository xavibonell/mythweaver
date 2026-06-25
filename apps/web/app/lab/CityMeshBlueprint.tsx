'use client';

/**
 * Blueprint tab — an inspector for the block-centric CityMesh layout core (the town/city rewrite). It
 * fetches the float Voronoi ward mesh from the backend (GET /scene/citymesh) and draws it as a vector
 * blueprint: the ward cells, plus the structures DERIVED from them in-browser — the curtain wall
 * (boundary edges), street corridors (shared edges) and the adjacency skeleton. Toggle layers, reseed,
 * and dial the ward count, so we can iterate the layout's "nuance" before any tiles get involved.
 */
import { useCallback, useEffect, useState } from 'react';

type Pt = [number, number];
interface BlueprintPatch { c: 0 | 1; poly: Pt[]; st: Pt }
interface CityBlueprint { seed: number; nPatches: number; center: Pt; viewExtent: number; patches: BlueprintPatch[]; adj: [Pt, Pt][] }
interface Layers { cells: boolean; wall: boolean; streets: boolean; skeleton: boolean; seeds: boolean }

const LAYER_DEFS: [keyof Layers, string, string][] = [
  ['cells', 'ward cells', '#3b82f6'],
  ['wall', 'wall line (M1)', '#dc2626'],
  ['streets', 'street corridors (M2)', '#d97706'],
  ['skeleton', 'adjacency skeleton', '#0d9488'],
  ['seeds', 'seed points', '#64748b'],
];
const VB = { w: 1000, h: 680, pad: 26 };

/** Derive the wall (boundary edges, used by exactly one core cell) and street corridors (shared edges). */
function coreEdges(patches: BlueprintPatch[]) {
  const key = (p: Pt) => `${Math.round(p[0] * 4)},${Math.round(p[1] * 4)}`;
  const ek = (a: Pt, b: Pt) => { const ka = key(a), kb = key(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  const m = new Map<string, { a: Pt; b: Pt; n: number }>();
  for (const p of patches) {
    if (p.c !== 1) continue;
    for (let i = 0; i < p.poly.length; i++) {
      const a = p.poly[i]!, b = p.poly[(i + 1) % p.poly.length]!;
      const k = ek(a, b), e = m.get(k);
      if (e) e.n++; else m.set(k, { a, b, n: 1 });
    }
  }
  const wall: [Pt, Pt][] = [], streets: [Pt, Pt][] = [];
  for (const e of m.values()) (e.n === 1 ? wall : streets).push([e.a, e.b]);
  return { wall, streets };
}

export default function CityMeshBlueprint({ server }: { server: string }) {
  const [seed, setSeed] = useState(1);
  const [nPatches, setNPatches] = useState(15);
  const [data, setData] = useState<CityBlueprint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [layers, setLayers] = useState<Layers>({ cells: true, wall: true, streets: true, skeleton: false, seeds: false });

  const load = useCallback(async (s: number, n: number) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(`${server}/scene/citymesh?seed=${s}&nPatches=${n}`);
      const d = await res.json();
      if (!res.ok) setError(d.error ?? `error ${res.status}`); else setData(d);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [server]);

  useEffect(() => { load(seed, nPatches); }, [load, seed, nPatches]);

  // Fit the shown cells into the viewBox (flip Y so north is up).
  let fit: { s: number; minX: number; maxY: number; ox: number; oy: number } | null = null;
  if (data?.patches.length) {
    let a = 1e9, b = 1e9, c = -1e9, e = -1e9;
    for (const p of data.patches) for (const v of p.poly) { a = Math.min(a, v[0]); b = Math.min(b, v[1]); c = Math.max(c, v[0]); e = Math.max(e, v[1]); }
    const s = Math.min((VB.w - 2 * VB.pad) / (c - a || 1), (VB.h - 2 * VB.pad) / (e - b || 1)) * 0.98;
    fit = { s, minX: a, maxY: e, ox: VB.pad + (VB.w - 2 * VB.pad - (c - a) * s) / 2, oy: VB.pad + (VB.h - 2 * VB.pad - (e - b) * s) / 2 };
  }
  const T = (x: number, y: number): Pt => (fit ? [fit.ox + (x - fit.minX) * fit.s, fit.oy + (fit.maxY - y) * fit.s] : [0, 0]);
  const polyStr = (poly: Pt[]) => poly.map((v) => { const q = T(v[0], v[1]); return `${q[0].toFixed(1)},${q[1].toFixed(1)}`; }).join(' ');
  const edges = data ? coreEdges(data.patches) : { wall: [], streets: [] };
  const center = data ? T(data.center[0], data.center[1]) : [0, 0];

  const toggle = (k: keyof Layers) => setLayers((L) => ({ ...L, [k]: !L[k] }));
  const inp = { background: '#15120f', color: '#e8dfce', border: '1px solid #2a241f', borderRadius: 4, padding: '2px 6px' } as const;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', color: '#cdc4b4' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #2a241f', fontSize: '0.78rem', flex: '0 0 auto' }}>
        <span style={{ color: '#c9a227' }}>City mesh blueprint</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          seed
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} style={{ ...inp, width: 64 }} />
          <button onClick={() => setSeed((s) => s + 1)} disabled={busy} style={{ ...inp, color: '#c9a227', cursor: 'pointer' }} title="reshuffle (next seed)">↻</button>
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          wards
          <input type="range" min={5} max={30} value={nPatches} onChange={(e) => setNPatches(Number(e.target.value))} />
          <span style={{ width: 20, textAlign: 'right', color: '#e8dfce' }}>{nPatches}</span>
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {LAYER_DEFS.map(([k, label, col]) => (
            <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer', color: layers[k] ? '#e8dfce' : '#7c7464' }}>
              <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} style={{ accentColor: col }} />
              {label}
            </label>
          ))}
        </span>
        {busy && <span style={{ color: '#7c7464' }}>loading…</span>}
        {error && <span style={{ color: '#d98b8b' }}>⚠ {error}</span>}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <svg viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <rect x={0} y={0} width={VB.w} height={VB.h} fill="#12100d" />
          {data?.patches.map((p, i) => {
            const core = p.c === 1;
            if (core && !layers.cells) return <polygon key={i} points={polyStr(p.poly)} fill="none" stroke="rgba(148,163,184,0.30)" strokeWidth={0.8} />;
            return <polygon key={i} points={polyStr(p.poly)} fill={core && layers.cells ? 'rgba(59,130,246,0.14)' : 'none'} stroke={core ? 'rgba(59,130,246,0.55)' : 'rgba(148,163,184,0.30)'} strokeWidth={core ? 1 : 0.8} />;
          })}
          {layers.streets && edges.streets.map(([a, b], i) => { const p = T(a[0], a[1]), q = T(b[0], b[1]); return <line key={`s${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#d97706" strokeWidth={2} strokeLinecap="round" />; })}
          {layers.wall && edges.wall.map(([a, b], i) => { const p = T(a[0], a[1]), q = T(b[0], b[1]); return <line key={`w${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#dc2626" strokeWidth={3.6} strokeLinecap="round" />; })}
          {layers.skeleton && data?.adj.map(([a, b], i) => { const p = T(a[0], a[1]), q = T(b[0], b[1]); return <line key={`k${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#0d9488" strokeWidth={1.6} strokeDasharray="5 4" />; })}
          {layers.seeds && data?.patches.filter((p) => p.c === 1).map((p, i) => { const q = T(p.st[0], p.st[1]); return <circle key={`d${i}`} cx={q[0]} cy={q[1]} r={2.4} fill="#64748b" />; })}
          {data && <circle cx={center[0]} cy={center[1]} r={5} fill="none" stroke="#a78bfa" strokeWidth={2.2} />}
          {data && <circle cx={center[0]} cy={center[1]} r={1.6} fill="#a78bfa" />}
        </svg>
        {data && (
          <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: '0.72rem', color: '#9a8f7d', fontFamily: 'monospace', background: 'rgba(13,11,10,0.6)', padding: '3px 8px', borderRadius: 4 }}>
            seed {data.seed} · {data.nPatches} core wards · {edges.wall.length} wall segments · {edges.streets.length} street edges · {data.adj.length} adjacency links
          </div>
        )}
      </div>
    </div>
  );
}
