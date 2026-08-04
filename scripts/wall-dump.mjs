// Render the AUTOTILER's tile choice per wall cell as box-drawing glyphs, so wrong corners and
// "bumps" (a corner glyph mid-straight-run) are obvious. node scripts/wall-dump.mjs --seed 1 --region x,y,w,h
import { buildComponentSheet } from '../packages/scene/dist/index.js';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const seed = Number(arg('seed', '1')), kind = arg('kind', 'building:house'), count = Number(arg('count', '6'));
const map = buildComponentSheet(kind, count, seed);
const { cols, rows } = map.grid;
const door = new Set();
for (const a of map.ambiance) if (a.tag === 'door_house' || a.tag === 'arch') door.add(`${a.col},${a.row}`);
for (const e of map.entrances) door.add(`${e.col},${e.row}`);
const INT = new Set(['wood_floor', 'stone', 'flagstone', 'stone_brick', 'floor']);
const isInt = (t) => INT.has(t) || (t || '').startsWith('carpet');
const GLYPH = { _tl: '┌', _tr: '┐', _bl: '└', _br: '┘', _t: '─', _b: '─', _l: '│', _r: '│', '': '█' };
const reg = (arg('region', '') || '').split(',').map(Number);
const [x0, y0, x1, y1] = reg.length === 4 ? [reg[0], reg[1], reg[0] + reg[2], reg[1] + reg[3]] : [0, 0, cols, rows];
let out = '';
for (let r = y0; r < y1; r++) {
  let line = '';
  for (let c = x0; c < x1; c++) {
    const t = map.tiles[r]?.[c] ?? '';
    if (t.startsWith('wall_wood')) line += GLYPH[t.slice('wall_wood'.length)] ?? '?';
    else if (door.has(`${c},${r}`)) line += '+';
    else if (isInt(t)) line += '·';
    else if (t === 'grass' && map.walkable[r]?.[c] !== true) line += '"'; // fence
    else if (t === 'grass') line += ' ';
    else line += ',';
  }
  out += line + '\n';
}
console.log(`seed ${seed}  glyphs: ┌┐└┘ corners · ── horiz · │ vert · █ fill · + door · · floor · " fence\n`);
console.log(out);
