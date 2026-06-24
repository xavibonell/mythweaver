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
  const dark = deep ? [22, 54, 92] : [38, 92, 150];
  const mid = deep ? [32, 72, 116] : [52, 116, 178];
  const lite = deep ? [50, 98, 142] : [92, 158, 212];
  const foam = deep ? [56, 104, 148] : [104, 168, 218]; // a SUBTLE lap (close to lite), not bright foam that reads as noise
  const seed = deep ? 7 : 3;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) << 2;
    const n = noise(x, y, seed);
    // a CLEAN, near-uniform surface: mostly mid blue with only sparse, subtle ripples (busy noise reads as a "splotch")
    let col = n > 0.92 ? lite : n < 0.10 ? lerp(mid, dark, 0.6) : mid;
    const nf = 1;
    const onEdge = (edges.has('t') && y < nf) || (edges.has('b') && y >= S - nf) || (edges.has('l') && x < nf) || (edges.has('r') && x >= S - nf);
    if (onEdge) col = foam;
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
