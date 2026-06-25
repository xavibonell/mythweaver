/**
 * City realizer — rasterizes a float CityMesh onto the 16px tile grid (Stage G). The mesh is the
 * organic plan; this is the single place we go from continuous geometry to tiles.
 *
 * M0 is deliberately minimal: a closest-seed flat-colour fill of the ward cells, no buildings / walls
 * / streets. Its only job is the GO/NO-GO falsification — do irregular Voronoi wards alone read as
 * organic (vs the current axis-aligned grid)? Walls (M1), streets (M2), zoning + fill (M3+) build on it.
 */
import { type Canvas, type Rect } from './primitives.js';
import { type CityMesh } from './citymesh.js';

// A high-contrast debug palette (distinct terrain colours) so adjacent ward cells read as separate
// blocks. NOT semantic — real ward→terrain mapping arrives with zoning in M3.
const WARD_PALETTE = ['dirt', 'sand', 'stone', 'water_deep', 'flagstone', 'stone_brick'];

/**
 * Fit the mesh's city into `rect` and flood each tile with its nearest in-city patch's debug colour.
 * Tiles whose nearest patch is countryside stay the canvas base (grass) → the city reads as an
 * irregular blob on open ground, directly comparable to the current grid city.
 */
export function rasterizeWardsDebug(cv: Canvas, rect: Rect, mesh: CityMesh): void {
  const ext = mesh.viewExtent * 1.1; // a little air around the city
  const scale = Math.min(rect.w, rect.h) / (2 * ext); // tiles per world unit
  const ccx = rect.x + rect.w / 2, ccy = rect.y + rect.h / 2;
  for (let r = rect.y; r < rect.y + rect.h; r++) {
    for (let c = rect.x; c < rect.x + rect.w; c++) {
      const wx = mesh.center.x + (c + 0.5 - ccx) / scale;
      const wy = mesh.center.y + (r + 0.5 - ccy) / scale;
      const patch = mesh.patches[mesh.find(wx, wy)];
      if (patch?.withinCity) cv.set(c, r, WARD_PALETTE[(patch.id * 7) % WARD_PALETTE.length]!);
    }
  }
}
