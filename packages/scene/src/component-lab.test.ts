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
