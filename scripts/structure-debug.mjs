// Debug one seed: print checkStructure + an ASCII map so a "failing" invariant can be eyeballed
// (is it a real defect or a checker false-positive?).  node scripts/structure-debug.mjs --seed 152 --kind building:house --count 6
import { checkStructure, buildComponentSheet } from '../packages/scene/dist/index.js';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const seed = Number(arg('seed', '152')), kind = arg('kind', 'building:house'), count = Number(arg('count', '6'));
const map = buildComponentSheet(kind, count, seed);
const rep = checkStructure(map);
console.log('seed', seed, JSON.stringify({ leakedInterior: rep.leakedInterior, unreachable: rep.unreachable, freestandingWall: rep.freestandingWall, badDoor: rep.badDoor }));
console.log('samples:', rep.samples.map((s) => `${s.kind}@${s.col},${s.row}`).join('  '));

const { cols, rows } = map.grid;
const INT = new Set(['wood_floor', 'stone', 'flagstone', 'stone_brick', 'floor']);
const isInt = (t) => INT.has(t) || t.startsWith('carpet');
const door = new Set();
for (const a of map.ambiance) if (a.tag === 'door_house' || a.tag === 'arch') door.add(`${a.col},${a.row}`);
for (const e of map.entrances) door.add(`${e.col},${e.row}`);

// Replicate checkStructure's flood EXACTLY so the X marks match the reported `unreachable`.
const w = map.walkable, t = map.tiles;
const inb = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;
const walk = (c, r) => inb(c, r) && w[r][c] === true;
const interior = (c, r) => isInt(t[r]?.[c] ?? '');
const N4 = [[0,-1],[1,0],[0,1],[-1,0]];
// 1) exterior reach (border flood over walkable non-interior non-door ground)
const isExt = (c, r) => walk(c, r) && !interior(c, r) && !door.has(`${c},${r}`);
const seenExt = Array.from({ length: rows }, () => new Array(cols).fill(false));
const qe = [];
for (let c = 0; c < cols; c++) for (const r of [0, rows-1]) if (isExt(c, r) && !seenExt[r][c]) { seenExt[r][c] = true; qe.push([c, r]); }
for (let r = 0; r < rows; r++) for (const c of [0, cols-1]) if (isExt(c, r) && !seenExt[r][c]) { seenExt[r][c] = true; qe.push([c, r]); }
while (qe.length) { const [c, r] = qe.shift(); for (const [dc, dr] of N4) { const nc = c+dc, nr = r+dr; if (isExt(nc, nr) && !seenExt[nr][nc]) { seenExt[nr][nc] = true; qe.push([nc, nr]); } } }
// 2) reachability flood: interior ∪ doors ∪ enclosed-walkable (NOT exterior street)
const passI = (c, r) => inb(c, r) && (interior(c, r) || door.has(`${c},${r}`) || (walk(c, r) && !seenExt[r][c]));
const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
const q = [];
for (const k of door) { const [c, r] = k.split(',').map(Number); if (passI(c, r) && !seen[r][c]) { seen[r][c] = true; q.push([c, r]); } }
while (q.length) { const [c, r] = q.shift(); for (const [dc, dr] of N4) { const nc = c+dc, nr = r+dr; if (passI(nc, nr) && !seen[nr][nc]) { seen[nr][nc] = true; q.push([nc, nr]); } } }

const region = arg('region', '').split(',').map(Number); // optional x,y,w,h to zoom one building
const [x0, y0, x1, y1] = region.length === 4 ? [region[0], region[1], region[0]+region[2], region[1]+region[3]] : [0, 0, cols, rows];
let out = '';
for (let r = y0; r < y1; r++) {
  let line = '';
  for (let c = x0; c < x1; c++) {
    const tile = t[r]?.[c] ?? '';
    const k = `${c},${r}`;
    if (door.has(k)) line += 'D';
    else if (tile.startsWith('wall')) line += '#';
    else if (interior(c, r)) line += walk(c, r) ? (seen[r][c] ? '.' : 'X') : 'o'; // X = unreachable interior!
    else if (!w[r]?.[c]) line += tile === 'grass' || tile.startsWith('flower') || tile === 'bush' ? '"' : '+'; // fence/blocker
    else line += tile === 'grass' ? ' ' : ',';
  }
  out += line + '\n';
}
console.log('\nLEGEND: # wall · D door · . reachable-floor · X UNREACHABLE-floor · o furniture-on-floor · " fence/plant · + blocker · (space) grass\n');
console.log(out);
