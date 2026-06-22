import { describe, expect, it } from 'vitest';
import { validateSceneMap } from '@mythweaver/shared';
import { buildComponentSheet, COMPONENT_KINDS } from './component-lab.js';

describe('component contact sheet — isolated micro-generator gallery', () => {
  it.each(COMPONENT_KINDS)('"%s" → a valid SceneMap of tiled instances', (kind) => {
    expect(validateSceneMap(buildComponentSheet(kind, 6, 1))).toEqual({ ok: true, violations: [] });
  });

  it('is deterministic (same kind+count+seed → byte-identical sheet)', () => {
    expect(JSON.stringify(buildComponentSheet('building:tavern', 6, 7))).toBe(JSON.stringify(buildComponentSheet('building:tavern', 6, 7)));
  });

  it('a different seed reshuffles the sheet', () => {
    const a = buildComponentSheet('building:tavern', 6, 1);
    const b = buildComponentSheet('building:tavern', 6, 2);
    expect(JSON.stringify(a.objects)).not.toBe(JSON.stringify(b.objects));
  });

  it('a building sheet produces multiple furnished compounds (one keeper each)', () => {
    const m = buildComponentSheet('building:tavern', 6, 1);
    const keepers = m.objects.filter((o) => o.kind === 'actor' && o.id.endsWith('-keeper'));
    expect(keepers.length).toBeGreaterThanOrEqual(4); // ~one per cell
  });
});

describe('furnishing invariants — beds and windows are correctly oriented', () => {
  const BED_TAGS = new Set(['bed', 'bed_down', 'bed_blue', 'bed_right']);
  const isWall = (m: ReturnType<typeof buildComponentSheet>, c: number, r: number) => (m.tiles[r]?.[c] ?? '').startsWith('wall');

  it('every room has ≤2 beds, all in ONE orientation (never a mixed/oversized bedroom)', () => {
    let roomsWithBeds = 0;
    for (const kind of ['shape:compose', 'building:house', 'building:tavern', 'building:temple']) {
      for (let s = 1; s <= 40; s++) {
        const byRoom = new Map<string, string[]>();
        for (const o of buildComponentSheet(kind, 6, s).objects)
          if (o.kind === 'prop' && BED_TAGS.has(o.tag)) { const g = o.group ?? '?'; (byRoom.get(g) ?? byRoom.set(g, []).get(g)!).push(o.tag); }
        for (const tags of byRoom.values()) {
          roomsWithBeds++;
          expect(tags.length).toBeLessThanOrEqual(2);          // never more than two beds
          expect(new Set(tags).size).toBe(1);                  // all the same orientation
        }
      }
    }
    expect(roomsWithBeds).toBeGreaterThan(50); // the sweep actually exercised beds
  });

  it('beds sit flush against their wall (headboard ON the wall, not floating a cell off it)', () => {
    const SIDE: Record<string, [number, number]> = { bed: [0, -1], bed_down: [0, 1], bed_blue: [-1, 0], bed_right: [1, 0] };
    let flush = 0, total = 0;
    for (const kind of ['shape:compose', 'shape:you', 'shape:ell', 'building:house', 'building:tavern']) {
      for (let s = 1; s <= 30; s++) {
        const m = buildComponentSheet(kind, 6, s);
        for (const o of m.objects) {
          const dir = o.kind === 'prop' ? SIDE[o.tag] : undefined;
          if (!dir) continue;
          total++;
          if (isWall(m, o.col + dir[0], o.row + dir[1])) flush++; // a real wall on the headboard side
        }
      }
    }
    expect(total).toBeGreaterThan(200);
    expect(flush / total).toBeGreaterThan(0.95); // ≥95% flush; the rest are beds beside an inter-room doorway
  });

  it('windows match their wall orientation: frontal on horizontal runs, side on vertical runs', () => {
    let front = 0, side = 0;
    for (const kind of ['shape:compose', 'building:house', 'building:tavern']) {
      for (let s = 1; s <= 40; s++) {
        const m = buildComponentSheet(kind, 6, s);
        for (const a of m.ambiance) {
          const h = isWall(m, a.col - 1, a.row) && isWall(m, a.col + 1, a.row);
          const v = isWall(m, a.col, a.row - 1) && isWall(m, a.col, a.row + 1);
          if (a.tag === 'window_front') { front++; expect(h && !v).toBe(true); } // face-on → horizontal wall only
          if (a.tag === 'window') { side++; expect(v && !h).toBe(true); }        // side → vertical wall only
        }
      }
    }
    expect(front).toBeGreaterThan(100);
    expect(side).toBeGreaterThan(100);
  });
});
