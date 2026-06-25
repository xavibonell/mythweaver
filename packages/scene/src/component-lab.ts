/**
 * Component LAB — a CONTACT SHEET of micro-generators, for tight iteration on ONE component in
 * isolation. Pick a kind (a building type, a vignette, a density texture, a street sample…), get N
 * seed-varied instances tiled in a grid on ONE SceneMap, eyeball them side by side, tune that
 * generator, repeat. Deterministic, no LLM, $0.
 *
 * Why this works (see docs/TOWN-BUILDER-NOTES.md): the rich components are SELF-CONTAINED pure
 * functions — `compound(canvas, rect, type)`, `vignette(canvas, anchor, type)`, `poissonScatter`,
 * `cave`/`clearing`/`bspRooms` — so a lone instance on a blank cell is faithful. The only thing that
 * does NOT decouple is a building's door FACING the nearest street (cosmetic in isolation → fixed
 * 'south' here) and the street/parcel PLACEMENT (relational → judge in the full town view, not here).
 *
 * The cells are intentionally disconnected islands, so we finalize with skipReachability (otherwise the
 * reachability net would tunnel corridors between cells and ruin the gallery).
 */

import { type SceneMap } from '@mythweaver/shared';
import { bspRooms, building, Canvas, cave, clearing, clumpScatter, compound, fill, finalize, maze, place, plaza, poissonScatter, vignette, type Rect } from './primitives.js';
import { GENERATORS, type Contents } from './archetypes.js';
import { precinctSquare } from './precinct.js';
import { blockCottage, blockTown } from './blocks.js';
import { buildCityMesh } from './citymesh.js';
import { rasterizeWardsDebug } from './city-realizer.js';
import { THEMES } from './themes.js';
import { type ShapeKind } from './footprint.js';

/** The components you can iterate on, grouped by family for the Lab dropdown. */
export const COMPONENT_KINDS = [
  'building:tavern', 'building:temple', 'building:smithy', 'building:shop', 'building:house',
  'building:inn', 'building:general_store', 'building:cathedral', 'building:jail', 'building:vault',
  'building:keep', 'building:library', 'building:armory', 'building:barracks', 'building:guildhall', 'building:goblin_warren', 'building:manor',
  'building:tomb', 'building:courthouse', 'building:workshop', 'building:curio',
  'shape:rect', 'shape:ell', 'shape:tee', 'shape:you', 'shape:plus', 'shape:compose', 'shape:compose:temple', 'shape:compose:tavern', 'shape:compose:smithy', 'shape:compose:shop',
  'vignette:market', 'vignette:forge', 'vignette:shrine', 'vignette:well', 'vignette:camp', 'vignette:graveyard',
  'plaza', 'streets', 'density:trees', 'density:flowers', 'density:furniture',
  'clearing', 'cave', 'rooms', 'maze',
  'town', 'village', // full procedural settlements (townGen) — seed-varied, for assessing town COMPOSITION
  'precinct', // a single hand-designed PRECINCT (central square) — the pattern-vault prototype, frontage-packed
  'block:cottage', // hand-authored BLOCK composition (cottage + garden + path + life) — the block-vault proof
  'blocktown', // a NEIGHBOURHOOD: hand-authored blocks stitched into a road grid — the vault at town scale
  'citymesh', // M0: block-centric Voronoi ward mesh — flat ward-colour fills, the anti-grid falsification
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

const BUILDING_TYPES = ['tavern', 'temple', 'smithy', 'shop', 'house', 'inn', 'general_store', 'cathedral', 'jail', 'vault', 'keep', 'library', 'armory', 'barracks', 'guildhall', 'goblin_warren', 'manor', 'tomb', 'courthouse', 'workshop', 'curio'] as const;
const onGrass = (cv: Canvas, c: number, r: number) => cv.tileAt(c, r) === 'grass';
const nearTile = (cv: Canvas, c: number, r: number, tag: string) => cv.tileAt(c, r - 1) === tag || cv.tileAt(c, r + 1) === tag || cv.tileAt(c - 1, r) === tag || cv.tileAt(c + 1, r) === tag;

interface CellSpec { cw: number; ch: number; render: (cv: Canvas, rect: Rect, i: number) => void; }

function specFor(kind: string): CellSpec {
  if (kind.startsWith('building:')) {
    const type = (BUILDING_TYPES as readonly string[]).includes(kind.slice(9)) ? (kind.slice(9) as (typeof BUILDING_TYPES)[number]) : 'house';
    return {
      cw: 16, ch: 14,
      render: (cv, rect, i) => {
        // jittered footprint inside the cell → buildings vary in size cell-to-cell (small cottage → big compound)
        const mx = 1 + Math.floor(cv.rng() * 3), my = 1 + Math.floor(cv.rng() * 3);
        let fp: Rect = { x: rect.x + mx, y: rect.y + my, w: rect.w - mx - (1 + Math.floor(cv.rng() * 3)), h: rect.h - my - (1 + Math.floor(cv.rng() * 2)) };
        if (fp.w < 5 || fp.h < 5) fp = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
        compound(cv, fp, type, { door: 'south', id: `bldg:c${i}`, locationId: 'loc:lab-component' });
      },
    };
  }
  if (kind.startsWith('shape:')) {
    // iterate ONE footprint shape (rect/L/T/U/cross/compose) in isolation — bigger cells so the silhouette is
    // legible. `shape:<shape>` defaults the building TYPE to house; `shape:<shape>:<type>` targets any type
    // (e.g. shape:compose:temple) — proving SHAPE (geometry) is orthogonal to TYPE (furnishing) in compound().
    const [shapeStr, typeStr] = kind.slice(6).split(':');
    const shape = shapeStr as ShapeKind;
    const type = (BUILDING_TYPES as readonly string[]).includes(typeStr ?? '') ? (typeStr as (typeof BUILDING_TYPES)[number]) : 'house';
    return {
      cw: 19, ch: 17,
      render: (cv, rect, i) => {
        const mx = 1 + Math.floor(cv.rng() * 2), my = 1 + Math.floor(cv.rng() * 2);
        let fp: Rect = { x: rect.x + mx, y: rect.y + my, w: rect.w - mx - (1 + Math.floor(cv.rng() * 2)), h: rect.h - my - (1 + Math.floor(cv.rng() * 2)) };
        if (fp.w < 13 || fp.h < 13) fp = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
        compound(cv, fp, type, { door: 'south', shape, id: `bldg:c${i}`, locationId: 'loc:lab-component' });
      },
    };
  }
  if (kind.startsWith('vignette:')) {
    const type = kind.slice(9);
    return { cw: 10, ch: 9, render: (cv, rect, i) => vignette(cv, { c: rect.x + Math.floor(rect.w / 2), r: rect.y + Math.floor(rect.h / 2) }, type, `vig${i}`) };
  }
  if (kind.startsWith('density:')) {
    const what = kind.slice(8);
    return {
      cw: 16, ch: 14,
      render: (cv, rect, i) => {
        if (what === 'trees') {
          poissonScatter(cv, rect, { tags: ['tree_oak', 'tree', 'tree_pine', 'tree_autumn', 'tree_dark', 'bush'], r: 3, blocks: true, filter: (c, r) => onGrass(cv, c, r) });
          clumpScatter(cv, rect, { tags: ['tree_oak', 'tree_dark', 'tree_pine'], freq: 0.25, threshold: 0.66, seedOffset: 0x77 + i, blocks: true, filter: (c, r) => onGrass(cv, c, r) });
        } else if (what === 'flowers') {
          clumpScatter(cv, rect, { tags: ['flowers', 'flowers_blue', 'flowers_yellow', 'flowers_red', 'grass_tuft', 'mushroom', 'bush'], freq: 0.16, threshold: 0.5, seedOffset: 0x99 + i, blocks: false, filter: (c, r) => onGrass(cv, c, r) });
        } else { // furniture along a dirt lane
          fill(cv, { x: rect.x, y: rect.y + Math.floor(rect.h / 2), w: rect.w, h: 1 }, 'dirt', true);
          poissonScatter(cv, rect, { tags: ['signpost', 'fence', 'woodpile', 'barrel', 'crate', 'market_stall'], r: 3, blocks: true, filter: (c, r) => onGrass(cv, c, r) });
        }
      },
    };
  }
  switch (kind) {
    case 'plaza':
      return {
        cw: 13, ch: 11,
        render: (cv, rect, i) => {
          const pr: Rect = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
          plaza(cv, pr, 'road');
          vignette(cv, { c: rect.x + Math.floor(rect.w / 2), r: rect.y + Math.floor(rect.h / 2) }, i % 2 ? 'market' : 'well', `plaza${i}`);
          place(cv, { id: `prop:bench${i}a`, tag: 'stone_bench', kind: 'prop', at: { c: pr.x + 1, r: pr.y + 1 } });
          place(cv, { id: `prop:bench${i}b`, tag: 'stone_bench', kind: 'prop', at: { c: pr.x + pr.w - 2, r: pr.y + pr.h - 2 } });
        },
      };
    case 'streets':
      return {
        cw: 16, ch: 14,
        render: (cv, rect, i) => {
          fill(cv, { x: rect.x, y: rect.y + Math.floor(rect.h / 2) - 1, w: rect.w, h: 2 }, 'road', true); // cobble artery
          fill(cv, { x: rect.x + Math.floor(rect.w / 2), y: rect.y, w: 1, h: rect.h }, 'dirt', true); // dirt alley
          poissonScatter(cv, rect, { tags: ['tree', 'bush'], r: 3, blocks: true, filter: (c, r) => onGrass(cv, c, r) });
          clumpScatter(cv, rect, { tags: ['flowers', 'grass_tuft'], freq: 0.2, threshold: 0.5, seedOffset: 0x33 + i, blocks: false, filter: (c, r) => onGrass(cv, c, r) });
          poissonScatter(cv, rect, { tags: ['signpost', 'fence', 'barrel', 'crate'], r: 4, blocks: true, max: 4, filter: (c, r) => onGrass(cv, c, r) && nearTile(cv, c, r, 'road') });
        },
      };
    case 'clearing':
      return { cw: 16, ch: 14, render: (cv, rect) => clearing(cv, rect) };
    case 'cave':
      return { cw: 16, ch: 14, render: (cv, rect) => cave(cv, rect, 'wall', 'stone') };
    case 'rooms':
      return { cw: 16, ch: 14, render: (cv, rect) => { bspRooms(cv, rect, 4, 'wall', 'stone'); } };
    case 'maze':
      return { cw: 16, ch: 14, render: (cv, rect) => maze(cv, rect, 'wall', 'grass') };
    case 'town':
    case 'village': {
      // A full procedural settlement (townGen), seed-varied per cell — the surface for assessing town
      // COMPOSITION (streets, plaza, zoning, entrance paths, framing). A believable roster of the 21 types.
      const big = kind === 'town';
      const roster: Contents = {
        buildings: [
          { type: 'cathedral' }, { type: 'keep', name: 'the keep' }, { type: 'manor' }, { type: 'guildhall' }, { type: 'courthouse' },
          { type: 'tavern', name: 'the inn' }, { type: 'inn' }, { type: 'temple' }, { type: 'smithy' }, { type: 'general_store' },
          { type: 'library' }, { type: 'armory' }, { type: 'shop' }, { type: 'curio' }, { type: 'workshop' }, { type: 'barracks' },
        ],
        landmarks: [{ tag: 'well' }],
        npcs: [{ tag: 'villager' }, { tag: 'villager_woman' }, { tag: 'knight' }, { tag: 'wizard' }, { tag: 'ranger' }],
        mobs: [],
        wall: false,
      };
      return {
        cw: big ? 56 : 36, ch: big ? 44 : 30,
        render: (cv, rect, i) => GENERATORS.town(cv, { theme: THEMES.village ?? Object.values(THEMES)[0]!, contents: roster, bounds: rect, locationId: `loc:lab-town-${i}` }),
      };
    }
    case 'precinct':
      // The CENTRAL SQUARE precinct — the pattern-vault prototype. A big cell so the packed belt + parks fit.
      return { cw: 78, ch: 70, render: (cv, rect, i) => precinctSquare(cv, rect, `loc:lab-precinct-${i}`) };
    case 'block:cottage':
      // A hand-authored residential BLOCK (cottage + garden + path + life) — the block-vault proof. Big enough that
      // building SHAPES (L/T/U/compose) fit and vary cell-to-cell.
      return { cw: 22, ch: 21, render: (cv, rect, i) => blockCottage(cv, rect, `loc:lab-block-${i}`) };
    case 'blocktown':
      // A NEIGHBOURHOOD stitched from hand-authored blocks — the vault at town scale. Extra margin for a forest surround.
      return { cw: 100, ch: 90, render: (cv, rect, i) => blockTown(cv, rect, `loc:lab-blocktown-${i}`) };
    case 'citymesh':
      // M0 — the block-centric Voronoi ward mesh, rasterized as flat ward-colour fills (no buildings/walls/streets).
      // The cheap falsification: do irregular wards alone kill the grid look? Big cell so the whole city fits.
      return { cw: 80, ch: 72, render: (cv, rect, i) => rasterizeWardsDebug(cv, rect, buildCityMesh(cv.seed + i * 1009, { nPatches: 15 })) };
    default:
      return { cw: 16, ch: 14, render: (cv, rect, i) => { void i; building(cv, { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 }, 'house', { door: 'south', id: 'bldg:fallback' }); } };
  }
}

/** Build a contact sheet: `count` seed-varied instances of `kind`, tiled in a grid, as one SceneMap. */
export function buildComponentSheet(kind: string, count: number, seed: number): SceneMap {
  const n = Math.max(1, Math.min(12, Math.floor(count) || 6));
  const { cw, ch, render } = specFor(kind);
  const cols = Math.min(n, 4);
  const rows = Math.ceil(n / cols);
  const gut = 2;
  const W = cols * (cw + gut) + gut, H = rows * (ch + gut) + gut;
  const cv = new Canvas(W, H, seed, 'grass');
  for (let i = 0; i < n; i++) {
    const gx = i % cols, gy = Math.floor(i / cols);
    render(cv, { x: gut + gx * (cw + gut), y: gut + gy * (ch + gut), w: cw, h: ch }, i);
  }
  // the precinct + block kinds do their OWN deliberate planting → skip the uniform ground-decal sprinkle (noise).
  return finalize(cv, { locationId: 'loc:lab-component', biome: 'village', lighting: 'day', grammar: 'open-outdoor', outdoor: true, skipReachability: true, skipDecals: kind === 'precinct' || kind === 'citymesh' || kind.startsWith('block') });
}
