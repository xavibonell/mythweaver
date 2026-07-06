import { describe, expect, it } from 'vitest';
import { FakeLlmProvider, fakeText } from '@mythweaver/llm';
import { validateSceneMap } from '@mythweaver/shared';
import { LlmSceneProgrammer, normalizeProgram, runProgram } from './scene-program.js';

describe('LLM scene programmer (G1b) — normalize + compose', () => {
  it('normalizes a clean program', () => {
    const p = normalizeProgram(
      { cols: 38, rows: 24, base: 'water', biome: 'forest', lighting: 'day', grammar: 'open-outdoor', outdoor: true, ops: [{ op: 'fill', region: 'all', tag: 'water' }, { op: 'island', region: { x: 4, y: 4, w: 10, h: 8 } }] },
      'a lake',
    );
    expect(p.cols).toBe(38);
    expect(p.ops).toHaveLength(2);
    expect(validateSceneMap(runProgram(p))).toEqual({ ok: true, violations: [] });
  });

  it('repairs garbage: bad tags → catalog, bad grammar/biome → defaults, ids → kind-correct + unique', () => {
    const p = normalizeProgram(
      {
        grammar: 'nonsense', biome: 'bananas', cols: 9999, rows: -3, base: 'plasma',
        ops: [
          { op: 'maze', region: 'all', wall: 'notatile', floor: 'alsobad' },
          { op: 'place', id: 'whatever', tag: 'not_a_real_prop', kind: 'prop', at: 'center' },
          { op: 'place', id: 'whatever', tag: 'dragon', kind: 'actor', role: 'mob', at: 'north' }, // dup id → deduped
          { op: 'scatter', idBase: 'goblins!!', tags: ['goblin', 'bogus'], kind: 'actor', role: 'mob', region: 'all', count: 999 },
          { op: 'garbage-op' },
        ],
      },
      'a weird place',
    );
    expect(p.grammar).toBe('open-outdoor'); // bad grammar → default
    expect(p.biome).toBe('forest'); // bad biome → default
    expect(p.base).toBe('grass'); // bad terrain → default
    expect(p.cols).toBeLessThanOrEqual(96);
    expect(p.rows).toBeGreaterThanOrEqual(12);
    expect(p.ops.find((o) => o.op === 'garbage-op' as never)).toBeUndefined(); // unknown op dropped
    const ids = p.ops.filter((o): o is Extract<typeof o, { id: string }> => 'id' in o).map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length); // dup id deduped
    expect(ids.every((id) => /^(prop|npc|mob|pc|bldg):[a-z0-9]/.test(id))).toBe(true); // kind-correct prefixes
    const sc = p.ops.find((o) => o.op === 'scatter');
    expect(sc && 'count' in sc ? sc.count : 0).toBeLessThanOrEqual(40); // clamped
    expect(validateSceneMap(runProgram(p))).toEqual({ ok: true, violations: [] }); // still valid by construction
  });

  it('infers actor kind from the id prefix when the model omits kind:actor (the missing-creatures bug)', () => {
    const p = normalizeProgram(
      { ops: [{ op: 'scatter', idBase: 'mob:croc', tags: ['frog'], region: 'all', count: 4 }, { op: 'place', id: 'npc:cultist', tag: 'wizard', at: 'center' }] },
      'swamp',
    );
    const sc = p.ops.find((o) => o.op === 'scatter');
    const pl = p.ops.find((o) => o.op === 'place');
    expect(sc && 'kind' in sc ? sc.kind : '').toBe('actor');
    expect(sc && 'role' in sc ? sc.role : '').toBe('mob');
    expect(pl && 'kind' in pl ? pl.kind : '').toBe('actor');
    expect(pl && 'role' in pl ? pl.role : '').toBe('npc');
  });

  it('injects brief-named creatures the LLM forgot (completeness net)', () => {
    // program has NO actor ops, but the brief names skeletons + goblins → they must be injected.
    const p = normalizeProgram({ ops: [{ op: 'rooms', region: 'all', count: 10 }] }, 'a crypt full of skeletons and goblins lurking in the dark');
    const m = runProgram(p);
    const tags = new Set(m.objects.filter((o) => o.kind === 'actor').map((o) => o.tag));
    expect(tags.has('skeleton')).toBe(true);
    expect(tags.has('goblin')).toBe(true);
  });

  it('does NOT double-inject creatures the LLM already placed', () => {
    const p = normalizeProgram({ ops: [{ op: 'scatter', idBase: 'mob:goblin', tags: ['goblin'], kind: 'actor', role: 'mob', region: 'all', count: 5 }] }, 'goblins everywhere');
    expect(p.ops.filter((o) => o.op === 'scatter' && 'tags' in o && o.tags.includes('goblin')).length).toBe(1);
  });

  it('building op produces a FURNISHED room (furniture + a keeper) — the restore', () => {
    const p = normalizeProgram({ cols: 24, rows: 16, outdoor: false, grammar: 'enclosed-interior', ops: [{ op: 'building', type: 'tavern', region: { x: 3, y: 3, w: 12, h: 9 } }] }, 'a tavern');
    const m = runProgram(p);
    expect(m.objects.filter((o) => o.kind === 'prop').length).toBeGreaterThan(2); // tables/chairs/barrels…
    expect(m.objects.filter((o) => o.kind === 'actor' && o.id.includes('keeper')).length).toBe(1);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
  });

  it('multiple building ops get unique ids (no keeper/furniture collision)', () => {
    const p = normalizeProgram({ cols: 40, rows: 16, ops: [{ op: 'building', type: 'house', region: { x: 2, y: 2, w: 9, h: 9 } }, { op: 'building', type: 'house', region: { x: 14, y: 2, w: 9, h: 9 } }] }, 'two houses');
    const m = runProgram(p);
    expect(new Set(m.objects.map((o) => o.id)).size).toBe(m.objects.length);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
  });

  it('maps structure synonyms to a furnishing template (forge→smithy, chapel→temple)', () => {
    const p = normalizeProgram({ ops: [{ op: 'building', type: 'forge', region: { x: 2, y: 2, w: 8, h: 8 } }, { op: 'building', type: 'chapel', region: { x: 12, y: 2, w: 8, h: 8 } }] }, 'x');
    const types = p.ops.filter((o) => o.op === 'building').map((o) => (o.op === 'building' ? o.type : ''));
    expect(types).toEqual(['smithy', 'temple']);
  });

  it('theme enforces ONE ground palette — the LLM per-op floor tag is ignored (no noise)', () => {
    // A non-settlement brief stays on the loose-op path (a settlement would route to the town generator).
    const p = normalizeProgram({ theme: 'forest', ops: [{ op: 'fill', region: 'all', tag: 'cobblestone' }, { op: 'plaza', region: { x: 5, y: 5, w: 6, h: 6 }, tag: 'stone_brick' }] }, 'a quiet woodland glade');
    expect(p.theme).toBe('forest');
    const m = runProgram(p);
    const tiles = m.tiles.flat();
    expect(tiles.some((t) => t === 'cobblestone' || t === 'stone_brick')).toBe(false); // clashing per-op tags overridden by the theme
    expect(tiles.some((t) => t.startsWith('grass'))).toBe(true); // theme.ground
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
  });

  it('theme is inferred from the brief when omitted', () => {
    expect(normalizeProgram({ ops: [] }, 'a dank crypt of bones and dust').theme).toBe('crypt');
    expect(normalizeProgram({ ops: [] }, 'a scorching desert oasis').theme).toBe('desert');
    expect(normalizeProgram({ ops: [] }, 'a cozy market town').theme).toBe('village');
  });

  it('vignette op drops an authored set-piece cluster', () => {
    const p = normalizeProgram({ theme: 'village', ops: [{ op: 'fill', region: 'all' }, { op: 'vignette', type: 'market', at: 'center' }, { op: 'vignette', type: 'forge', at: { c: 8, r: 8 } }] }, 'a market with a forge');
    const m = runProgram(p);
    expect(m.objects.filter((o) => o.tag === 'market_stall').length).toBeGreaterThan(0);
    expect(m.objects.filter((o) => o.tag === 'weapon_rack').length).toBeGreaterThan(0); // the forge vignette
    expect(new Set(m.objects.map((o) => o.id)).size).toBe(m.objects.length); // unique ids across vignettes
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
  });

  it('cave op produces an organic cavern (open floor + rock walls) that is valid', () => {
    const p = normalizeProgram({ theme: 'cave', grammar: 'enclosed-interior', outdoor: false, cols: 40, rows: 28, ops: [{ op: 'cave', region: 'all' }, { op: 'scatter', idBase: 'mob:bat', tags: ['spider'], kind: 'actor', role: 'mob', region: 'all', count: 6 }, { op: 'place', id: 'prop:hoard', tag: 'chest', kind: 'prop', at: 'center' }] }, 'a cavern lair');
    const m = runProgram(p);
    const tiles = m.tiles.flat();
    const floor = tiles.filter((t) => !t.startsWith('wall')).length;
    expect(floor).toBeGreaterThan(60); // has a real open cavern
    expect(tiles.some((t) => t.startsWith('wall'))).toBe(true); // and rock walls
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] }); // actors land on walkable, connected
  });

  it('injects a structural backbone when an interior brief has none (the flat-dungeon fix)', () => {
    // the failure mode: LLM emits a flat dungeon (fill + scatter, no structure)
    const dungeon = normalizeProgram({ ops: [{ op: 'fill', region: 'all', tag: 'stone' }, { op: 'scatter', idBase: 'mob:goblin', tags: ['goblin'], kind: 'actor', role: 'mob', region: 'all', count: 6 }] }, 'a stone dungeon of chambers full of goblins');
    expect(dungeon.ops.some((o) => o.op === 'rooms' || o.op === 'cave' || o.op === 'building')).toBe(true);
    const cavern = normalizeProgram({ ops: [{ op: 'fill', region: 'all', tag: 'dirt' }] }, 'a goblin cavern lair');
    expect(cavern.ops.some((o) => o.op === 'cave')).toBe(true);
    // outdoor briefs are NOT forced to have structure
    const meadow = normalizeProgram({ ops: [{ op: 'fill', region: 'all', tag: 'grass' }] }, 'a peaceful flower meadow');
    expect(meadow.ops.some((o) => o.op === 'rooms' || o.op === 'cave' || o.op === 'maze')).toBe(false);
  });

  it('injects brief-named landmark props the LLM omitted (sarcophagus/chest)', () => {
    const p = normalizeProgram({ ops: [{ op: 'rooms', region: 'all', count: 6 }] }, 'a crypt with a sarcophagus, an altar, and a treasure chest');
    const placed = new Set(p.ops.filter((o) => o.op === 'place').map((o) => (o.op === 'place' ? o.tag : '')));
    expect(placed.has('sarcophagus')).toBe(true);
    expect(placed.has('chest')).toBe(true);
    expect(placed.has('altar')).toBe(true);
  });

  it('does NOT drop a loose altar/throne when a building already furnishes the scene', () => {
    const p = normalizeProgram({ ops: [{ op: 'building', type: 'temple', region: { x: 2, y: 2, w: 9, h: 9 } }] }, 'a grand temple with an altar and a throne');
    const loose = p.ops.filter((o) => o.op === 'place' && (o.tag === 'altar' || o.tag === 'throne')).length;
    expect(loose).toBe(0); // the temple building furnishes its own altar
  });

  it('falls back to a runnable program when ops are empty/garbage', () => {
    const p = normalizeProgram({ ops: 'nope' }, 'x');
    expect(p.ops.length).toBeGreaterThan(0);
    expect(validateSceneMap(runProgram(p))).toEqual({ ok: true, violations: [] });
  });

  it('populates actors even on a water-heavy scene (the missing-crocodiles fix)', () => {
    // mostly-water map: a single small island; crocodiles scattered "in" the water must still appear.
    const p = normalizeProgram(
      { cols: 30, rows: 20, base: 'water', outdoor: true, ops: [{ op: 'fill', region: 'all', tag: 'water' }, { op: 'island', region: { x: 10, y: 6, w: 10, h: 8 } }, { op: 'scatter', idBase: 'mob:croc', tags: ['frog'], kind: 'actor', role: 'mob', region: 'all', count: 6 }] },
      'swamp',
    );
    const m = runProgram(p);
    expect(m.objects.filter((o) => o.role === 'mob').length).toBe(6); // all 6 placed (fell back onto the island)
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
  });

  it('is deterministic per brief (same brief → same seed → identical map)', () => {
    const prog = { cols: 40, rows: 26, ops: [{ op: 'maze', region: 'all' }, { op: 'scatter', idBase: 'mob:g', tags: ['goblin'], kind: 'actor', role: 'mob', region: 'all', count: 5 }] };
    const a = runProgram(normalizeProgram(prog, 'same brief'));
    const b = runProgram(normalizeProgram(prog, 'same brief'));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('composes from a (faked) LLM response → a valid scene', async () => {
    const json = JSON.stringify({
      cols: 40, rows: 26, base: 'grass', biome: 'forest', lighting: 'night', grammar: 'open-outdoor', outdoor: true,
      ops: [
        { op: 'maze', region: 'all', wall: 'wall', floor: 'grass' },
        { op: 'entrance', at: 'west' },
        { op: 'place', id: 'prop:fountain', tag: 'fountain', kind: 'prop', at: 'center' },
        { op: 'scatter', idBase: 'mob:skel', tags: ['skeleton'], kind: 'actor', role: 'mob', region: 'all', count: 6 },
      ],
    });
    const programmer = new LlmSceneProgrammer(new FakeLlmProvider([fakeText('Here you go: ' + json)]));
    const program = await programmer.compose('a labyrinth full of skeletons with a central fountain');
    expect(program.ops[0]!.op).toBe('maze');
    const m = runProgram(program);
    expect(validateSceneMap(m)).toEqual({ ok: true, violations: [] });
    expect(m.objects.some((o) => o.tag === 'fountain')).toBe(true);
    expect(m.objects.filter((o) => o.role === 'mob').length).toBeGreaterThan(3);
  });

  // The DM's declared `kind` (setScene) / a beat's ScenePlan kind FORCES the layout family — it beats
  // both the LLM's grammar guess and the keyword nets ("flooded mining town" must not become a town
  // when the DM said interior, nor an interior via the \bmine\b keyword when the DM said settlement).
  it('kindHint interior beats settlement keywords + the LLM grammar (and fires the structural net)', () => {
    const p = normalizeProgram(
      { grammar: 'town-square', outdoor: true, ops: [] },
      'a flooded mining town, gothic horror',
      'gothic horror of the drowned dead',
      'interior',
    );
    expect(p.grammar).toBe('enclosed-interior');
    expect(p.outdoor).toBe(false);
    expect(p.ops.some((o) => o.op === 'archetype')).toBe(false); // town routing suppressed
    expect(p.ops.some((o) => o.op === 'rooms' || o.op === 'cave' || o.op === 'maze')).toBe(true); // backbone injected
    expect(p.lighting).toBe('night'); // mood text still drives lighting
    expect(validateSceneMap(runProgram(p))).toEqual({ ok: true, violations: [] });
  });

  it('kindHint settlement routes to the town generator even without town keywords', () => {
    const p = normalizeProgram({ ops: [] }, 'a cluster of dwellings by the ford', 'a sunny morning', 'settlement');
    expect(p.grammar).toBe('town-square');
    expect(p.outdoor).toBe(true);
    expect(p.ops.some((o) => o.op === 'archetype' && o.kind === 'town')).toBe(true);
  });

  it('kindHint wild keeps open nature open even when the brief names a mine', () => {
    const p = normalizeProgram({ ops: [] }, 'the rocky path up to the old mine', 'day', 'wild');
    expect(p.grammar).toBe('open-outdoor');
    expect(p.ops.some((o) => o.op === 'archetype')).toBe(false);
    expect(p.ops.some((o) => o.op === 'rooms' || o.op === 'cave' || o.op === 'maze')).toBe(false); // no interior net
  });
});
