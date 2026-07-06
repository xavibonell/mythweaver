// Render the interior families (labyrinth / crypt / cave / chambers) headless — verifies the interior
// credibility pass (materials, organic caves, content kits, lighting) in one shot.
import { writeFileSync } from 'node:fs';
import { runProgram, GOLD_PROGRAMS, renderSceneMapToPng } from '@mythweaver/scene';

const assetsRoot = new URL('../apps/web/public', import.meta.url).pathname;

// A big natural cavern (exercises the new rock_wall default + cave formations).
const CAVE = {
  locationId: 'loc:cave-demo', cols: 40, rows: 26, seed: 77, biome: 'cave', lighting: 'night',
  grammar: 'enclosed-interior', outdoor: false,
  ops: [
    { op: 'cave', region: 'all', wall: 'rock_wall', floor: 'stone' },
    { op: 'scatter', idBase: 'mob', tags: ['ghoul', 'rat_giant'], kind: 'actor', role: 'enemy', region: { x: 4, y: 4, w: 32, h: 18 }, count: 5 },
    { op: 'place', id: 'prop:chest', tag: 'chest', kind: 'prop', at: { c: 20, r: 13 } },
    { op: 'entrance', at: { c: 20, r: 25 } },
  ],
};

// BSP chambers (exercises the flagstone rooms default + wall material unity).
const CHAMBERS = {
  locationId: 'loc:chambers-demo', cols: 40, rows: 26, seed: 33, biome: 'dungeon', lighting: 'night',
  grammar: 'enclosed-interior', outdoor: false,
  ops: [
    { op: 'rooms', region: 'all', count: 6, wall: 'wall', floor: 'flagstone' },
    { op: 'scatter', idBase: 'mob', tags: ['skeleton', 'kobold'], kind: 'actor', role: 'enemy', region: { x: 3, y: 3, w: 34, h: 20 }, count: 6 },
    { op: 'scatter', idBase: 'decor', tags: ['barrel', 'crate', 'bones'], kind: 'prop', region: { x: 3, y: 3, w: 34, h: 20 }, count: 8 },
    { op: 'entrance', at: { c: 20, r: 25 } },
  ],
};

const scenes = {
  labyrinth: runProgram(GOLD_PROGRAMS.labyrinth),
  crypt: runProgram(GOLD_PROGRAMS.crypt),
  cave: runProgram(CAVE),
  chambers: runProgram(CHAMBERS),
};

for (const [name, map] of Object.entries(scenes)) {
  const png = renderSceneMapToPng(map, { assetsRoot });
  const out = new URL(`../scratch-interiors/${name}.png`, import.meta.url).pathname;
  writeFileSync(out, png);
  const props = (map.objects ?? []).length, amb = (map.ambiance ?? []).length;
  console.log(`${name.padEnd(10)} ${map.cols}x${map.rows}  objects=${props} ambiance=${amb}  ${png.length}b -> ${out}`);
}
