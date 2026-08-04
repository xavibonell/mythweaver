// Generate a COBBLE auto-tile set: a unified large-brick body + a clean curb that runs ALONG each edge
// (horizontal curb on top/bottom, vertical on left/right, L on corners). Pure pngjs, deterministic.
// The old approach reused stone0 (vertical lines) for every rim, so top/bottom edges got lines perpendicular to
// the edge (the "weird pattern"). This makes the rim follow the edge. Re-run: node scripts/gen-cobble.mjs
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

const DIR = new URL('../apps/web/public/assets/dawnlike/terrain/', import.meta.url).pathname;
const S = 16;
const noise = (x, y) => { let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h >>> 8) / 0xffffff; };
const BRICK = [150, 152, 160], MORTAR = [104, 106, 116], CURB = [116, 118, 128], LIP = [176, 178, 186];

/** One cobble tile. `edges` = sides that border open ground → a curb runs along them. */
function cobble(edges) {
  const png = new PNG({ width: S, height: S });
  const t = edges.has('t'), b = edges.has('b'), l = edges.has('l'), r = edges.has('r');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) << 2;
    // body: large bricks, 8x4, running bond (alternate courses offset 4) → seamless, no continuous lines
    const course = Math.floor(y / 4), off = (course % 2) * 4;
    const joint = ((x + off) % 8 === 0) || (y % 4 === 0);
    const n = noise(x, y);
    let col = joint ? MORTAR : BRICK.map((v) => Math.max(0, Math.min(255, v + Math.round((n - 0.5) * 16))));
    // curb band ALONG each bordering edge: 2px curb + a 1px lighter lip just inside it
    if (t && y < 2) col = CURB; else if (t && y === 2) col = LIP;
    if (b && y >= S - 2) col = CURB; else if (b && y === S - 3) col = LIP;
    if (l && x < 2) col = CURB; else if (l && x === 2) col = LIP;
    if (r && x >= S - 2) col = CURB; else if (r && x === S - 3) col = LIP;
    png.data[i] = col[0]; png.data[i + 1] = col[1]; png.data[i + 2] = col[2]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const VARIANTS = { '': [], _t: ['t'], _b: ['b'], _l: ['l'], _r: ['r'], _tl: ['t', 'l'], _tr: ['t', 'r'], _bl: ['b', 'l'], _br: ['b', 'r'] };
let n = 0;
for (const [suf, e] of Object.entries(VARIANTS)) { writeFileSync(DIR + 'cobble' + suf + '.png', cobble(new Set(e))); n++; }
console.log(`wrote ${n} cobble tiles → ${DIR}`);
