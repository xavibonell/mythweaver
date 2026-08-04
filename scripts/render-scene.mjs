// Render a SceneMap JSON (from POST /scene/story|program) to a PNG via the headless game renderer.
// Usage: node scripts/render-scene.mjs <scene.json> <out.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { renderSceneMapToPng } from '@mythweaver/scene';

const [, , inPath, outPath] = process.argv;
const data = JSON.parse(readFileSync(inPath, 'utf8'));
const map = data.sceneMap ?? data;

const blob = JSON.stringify(map);
const probe = ['kobold', 'ogre', 'troll', 'lich', 'ghoul', 'wraith', 'ghost', 'guard', 'bandit',
  'minotaur', 'cyclops', 'giant_hill', 'giant_frost', 'giant_stone', 'mummy', 'imp', 'devil_bone',
  'rat_giant', 'spider_giant', 'orc_shaman', 'hobgoblin', 'bugbear', 'ettin',
  'sign_inn', 'sign_smithy', 'sign_church'].filter((t) => new RegExp('"' + t + '"').test(blob));
console.log('NEW tags present in scene:', probe.length ? probe.join(', ') : '(none)');

const png = renderSceneMapToPng(map, { assetsRoot: new URL('../apps/web/public', import.meta.url).pathname });
writeFileSync(outPath, png);
console.log('rendered', outPath, png.length, 'bytes');
