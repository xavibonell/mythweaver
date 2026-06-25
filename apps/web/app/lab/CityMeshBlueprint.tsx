'use client';

/**
 * Blueprint tab — an inspector for the block-centric CityMesh layout core (the town/city rewrite). It
 * fetches the float Voronoi ward mesh from the backend (GET /scene/citymesh) and draws it as a vector
 * blueprint: the ward cells by ZONE (core / extramural / rural), the optional curtain wall + gates, the
 * street corridors (derived in-browser from the cell polygons), and the adjacency skeleton. Toggle
 * layers, reseed, dial ward count, walls on/off — so we can iterate the layout before any tiles exist.
 *
 * Zones: the wall traces the CORE only; the EXTRAMURAL ring just outside is preserved (not discarded) so
 * later stages can fill it with flavour — scattered farms, a roadside vendor, a camp.
 */
import { useCallback, useEffect, useState } from 'react';

type Pt = [number, number];
type Zone = 'core' | 'extramural' | 'rural';
interface BlueprintPatch { z: Zone; poly: Pt[]; st: Pt }
interface CityBlueprint { seed: number; nPatches: number; center: Pt; viewExtent: number; patches: BlueprintPatch[]; adj: [Pt, Pt][]; wall?: { ring: Pt[]; gates: Pt[] } }
interface Layers { cells: boolean; zones: boolean; streets: boolean; skeleton: boolean; seeds: boolean }

const LAYER_DEFS: [keyof Layers, string, string][] = [
  ['cells', 'core wards', '#3b82f6'],
  ['zones', 'outer zones', '#b8a52e'],
  ['streets', 'street corridors', '#d97706'],
  ['skeleton', 'adjacency skeleton', '#0d9488'],
  ['seeds', 'seed points', '#64748b'],
];
const VB = { w: 1000, h: 680, pad: 30 };

/** Street corridors = core cell edges shared by two core cells (the wall is handled server-side). */
function streetEdges(patches: BlueprintPatch[]): [Pt, Pt][] {
  const key = (p: Pt) => `${Math.round(p[0] * 4)},${Math.round(p[1] * 4)}`;
  const ek = (a: Pt, b: Pt) => { const ka = key(a), kb = key(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  const m = new Map<string, { a: Pt; b: Pt; n: number }>();
  for (const p of patches) {
    if (p.z !== 'core') continue;
    for (let i = 0; i < p.poly.length; i++) {
      const a = p.poly[i]!, b = p.poly[(i + 1) % p.poly.length]!;
      const k = ek(a, b), e = m.get(k);
      if (e) e.n++; else m.set(k, { a, b, n: 1 });
    }
  }
  return [...m.values()].filter((e) => e.n > 1).map((e) => [e.a, e.b] as [Pt, Pt]);
}

export default function CityMeshBlueprint({ server }: { server: string }) {
  const [seed, setSeed] = useState(1);
  const [nPatches, setNPatches] = useState(15);
  const [walled, setWalled] = useState(true);
  const [data, setData] = useState<CityBlueprint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [layers, setLayers] = useState<Layers>({ cells: true, zones: true, streets: true, skeleton: false, seeds: false });

  const load = useCallback(async (s: number, n: number, w: boolean) => {
    setBusy(true); setError('');
    try {
      const res = await fetch(`${server}/scene/citymesh?seed=${s}&nPatches=${n}&wall=${w ? 1 : 0}`);
      const d = await res.json();
      if (!res.ok) setError(d.error ?? `error ${res.status}`); else setData(d);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [server]);

  useEffect(() => { load(seed, nPatches, walled); }, [load, seed, nPatches, walled]);

  // Fit the shown cells into the viewBox (flip Y so north is up).
  let fit: { s: number; minX: number; maxY: number; ox: number; oy: number } | null = null;
  if (data?.patches.length) {
    let a = 1e9, b = 1e9, c = -1e9, e = -1e9;
    for (const p of data.patches) for (const v of p.poly) { a = Math.min(a, v[0]); b = Math.min(b, v[1]); c = Math.max(c, v[0]); e = Math.max(e, v[1]); }
    const s = Math.min((VB.w - 2 * VB.pad) / (c - a || 1), (VB.h - 2 * VB.pad) / (e - b || 1)) * 0.98;
    fit = { s, minX: a, maxY: e, ox: VB.pad + (VB.w - 2 * VB.pad - (c - a) * s) / 2, oy: VB.pad + (VB.h - 2 * VB.pad - (e - b) * s) / 2 };
  }
  const T = (x: number, y: number): Pt => (fit ? [fit.ox + (x - fit.minX) * fit.s, fit.oy + (fit.maxY - y) * fit.s] : [0, 0]);
  const pstr = (poly: Pt[]) => poly.map((v) => { const q = T(v[0], v[1]); return `${q[0].toFixed(1)},${q[1].toFixed(1)}`; }).join(' ');
  const streets = data ? streetEdges(data.patches) : [];
  const center = data ? T(data.center[0], data.center[1]) : [0, 0];

  const FILL: Record<Zone, string> = { core: 'rgba(59,130,246,0.16)', extramural: 'rgba(184,165,46,0.16)', rural: 'none' };
  const STROKE: Record<Zone, string> = { core: 'rgba(59,130,246,0.55)', extramural: 'rgba(184,165,46,0.5)', rural: 'rgba(148,163,184,0.28)' };
  const shown = (z: Zone) => (z === 'core' ? layers.cells : z === 'extramural' ? layers.zones : true);

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
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer', color: walled ? '#e8dfce' : '#7c7464' }} title="not every settlement is walled">
          <input type="checkbox" checked={walled} onChange={(e) => setWalled(e.target.checked)} style={{ accentColor: '#dc2626' }} />
          city wall
        </label>
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
          {data?.patches.map((p, i) => shown(p.z) ? (
            <polygon key={i} points={pstr(p.poly)} fill={FILL[p.z]} stroke={STROKE[p.z]} strokeWidth={p.z === 'rural' ? 0.8 : 1} />
          ) : <polygon key={i} points={pstr(p.poly)} fill="none" stroke="rgba(148,163,184,0.22)" strokeWidth={0.8} />)}
          {layers.streets && streets.map(([a, b], i) => { const p = T(a[0], a[1]), q = T(b[0], b[1]); return <line key={`s${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#d97706" strokeWidth={2} strokeLinecap="round" />; })}
          {layers.skeleton && data?.adj.map(([a, b], i) => { const p = T(a[0], a[1]), q = T(b[0], b[1]); return <line key={`k${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#0d9488" strokeWidth={1.6} strokeDasharray="5 4" />; })}
          {data?.wall && <polygon points={pstr(data.wall.ring)} fill="none" stroke="#dc2626" strokeWidth={3.6} strokeLinejoin="round" />}
          {data?.wall?.gates.map((g, i) => { const q = T(g[0], g[1]); return <circle key={`g${i}`} cx={q[0]} cy={q[1]} r={5} fill="#12100d" stroke="#f0c040" strokeWidth={2.4} />; })}
          {layers.seeds && data?.patches.filter((p) => p.z === 'core').map((p, i) => { const q = T(p.st[0], p.st[1]); return <circle key={`d${i}`} cx={q[0]} cy={q[1]} r={2.4} fill="#64748b" />; })}
          {data && <circle cx={center[0]} cy={center[1]} r={5} fill="none" stroke="#a78bfa" strokeWidth={2.2} />}
          {data && <circle cx={center[0]} cy={center[1]} r={1.6} fill="#a78bfa" />}
        </svg>
        {data && (
          <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: '0.72rem', color: '#9a8f7d', fontFamily: 'monospace', background: 'rgba(13,11,10,0.6)', padding: '3px 8px', borderRadius: 4 }}>
            seed {data.seed} · {data.nPatches} core wards · {data.wall ? `${data.wall.gates.length} gates` : 'no wall'} · {streets.length} street edges · {data.patches.filter((p) => p.z === 'extramural').length} outer-zone cells
          </div>
        )}
      </div>
    </div>
  );
}
