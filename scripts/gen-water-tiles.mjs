// Generate BLUE water tiles (base + deep + all 8 auto-tile edges) — DawnLike's shipped water is near-black
// and reads as a hole, not water. Deterministic, pure pngjs. Re-run any time: node scripts/gen-water-tiles.mjs
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const DIR = new URL('../apps/web/public/assets/dawnlike/terrain/', import.meta.url).pathname;
const S = 16;

// stable value noise in [0,1)
const noise = (x, y, seed) => {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h >>> 8) / 0xffffff;
};
const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** A 16×16 water tile. `deep` = darker palette; `edges` = which sides get a lighter "lap/foam" band. */
function waterTile(deep, edges) {
  const png = new PNG({ width: S, height: S });
  const dark = deep ? [14, 36, 68] : [22, 56, 100];
  const mid = deep ? [22, 54, 92] : [44, 100, 158];   // lit water surface
  const lite = deep ? [40, 80, 120] : [92, 162, 216];  // bright ripples/reflections (high contrast = reads as water)
  const foam = deep ? [8, 22, 46] : [12, 30, 58];      // VERY dark rim shadow = the basin wall in deep shadow (sunken read)
  const seed = deep ? 7 : 3;
  const isEdge = edges.size > 0; // an edge tile IS the basin wall seen in deep shadow → render the whole cell dark
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) << 2;
    const n = noise(x, y, seed);
    const col = isEdge
      ? (n > 0.82 ? lerp(foam, dark, 0.5) : foam)                   // a full dark cell — a THICK visible depth ring
      : (n > 0.80 ? lite : n < 0.18 ? lerp(mid, dark, 0.55) : mid); // lit, rippled open-water surface
    png.data[i] = col[0]; png.data[i + 1] = col[1]; png.data[i + 2] = col[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const VARIANTS = { '': [], _t: ['t'], _b: ['b'], _l: ['l'], _r: ['r'], _tl: ['t', 'l'], _tr: ['t', 'r'], _bl: ['b', 'l'], _br: ['b', 'r'] };
let n = 0;
for (const [suf, e] of Object.entries(VARIANTS)) {
  writeFileSync(DIR + 'water' + suf + '.png', waterTile(false, new Set(e)));
  writeFileSync(DIR + 'water_deep' + suf + '.png', waterTile(true, new Set(e)));
  n += 2;
}
console.log(`wrote ${n} blue water tiles → ${DIR}`);
