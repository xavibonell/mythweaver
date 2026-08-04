// Blueprint extractor: build the M0 CityMesh for a few seeds and derive the structures the later tiers
// will consume — the CORE BOUNDARY (future wall = edges of the core not shared with another core cell),
// SHARED EDGES (future streets run along these), and CORE ADJACENCY (the street skeleton). Proves the
// mesh foundation already carries everything. Emits compact JSON (+ a summary) for the blueprint widget.
import { buildCityMesh } from '../packages/scene/dist/citymesh.js';
import { writeFileSync } from 'node:fs';

const SEEDS = [1, 7, 21];
const r = (n) => Math.round(n);

function meshData(seed) {
  const m = buildCityMesh(seed, { nPatches: 15 });
  const innerSet = new Set(m.inner);
  const key = (p) => `${Math.round(p.x * 4)},${Math.round(p.y * 4)}`; // quantize to weld shared vertices
  const ek = (a, b) => { const ka = key(a), kb = key(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };
  const edges = new Map();
  for (const id of m.inner) {
    const poly = m.patches[id].poly;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const k = ek(a, b), e = edges.get(k);
      if (e) e.count++; else edges.set(k, { a, b, count: 1 });
    }
  }
  const seg = (e) => [[r(e.a.x), r(e.a.y)], [r(e.b.x), r(e.b.y)]];
  const boundaryEdges = [...edges.values()].filter((e) => e.count === 1).map(seg); // the wall line
  const interiorEdges = [...edges.values()].filter((e) => e.count > 1).map(seg); // internal cell borders = streets
  const adj = [];
  for (const id of m.inner) for (const nb of m.patches[id].neighbours)
    if (innerSet.has(nb) && id < nb) adj.push([[r(m.patches[id].centroid.x), r(m.patches[id].centroid.y)], [r(m.patches[nb].centroid.x), r(m.patches[nb].centroid.y)]]);

  const [cx, cy] = [m.center.x, m.center.y];
  const lim = m.viewExtent * 1.45; // keep the core + a ring of countryside for context
  const patches = m.patches
    .filter((p) => Math.hypot(p.centroid.x - cx, p.centroid.y - cy) <= lim)
    .map((p) => ({ id: p.id, c: p.withinCity ? 1 : 0, poly: p.poly.map((v) => [r(v.x), r(v.y)]), ce: [r(p.centroid.x), r(p.centroid.y)], st: [r(p.site.x), r(p.site.y)] }));

  return { seed, center: [r(cx), r(cy)], viewExtent: r(m.viewExtent), cityRadius: r(m.cityRadius), inner: m.inner.length, patches, boundaryEdges, interiorEdges, adj };
}

const out = SEEDS.map(meshData);
writeFileSync('/tmp/citymesh-bp.json', JSON.stringify(out));
for (const d of out) console.log(`seed ${d.seed}: ${d.inner} core wards · ${d.patches.length} cells shown · ${d.boundaryEdges.length} wall segments · ${d.interiorEdges.length} interior street edges · ${d.adj.length} adjacency links`);
console.log('wrote /tmp/citymesh-bp.json');
