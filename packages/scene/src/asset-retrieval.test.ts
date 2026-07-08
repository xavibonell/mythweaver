import { describe, expect, it } from 'vitest';
import { AssetRetriever, loadAssetVectors, paletteBlock, type AssetVectorRow, type QueryEmbedder } from './asset-retrieval.js';
import { compileSpec, unresolvedSpecConcepts } from './spec-compile.js';
import { LlmSceneProgrammer } from './scene-program.js';
import type { SceneSpec } from '@mythweaver/shared';

/** Deterministic embedder: known strings map to fixed unit vectors; unknown → a far-away axis. */
const AXES: Record<string, number[]> = {
  'swampy query': [1, 0, 0, 0],
  'leviathan skeleton': [0, 1, 0, 0],
  'utter nonsense zzz': [0, 0, 0, 1],
};
const fakeEmbedder: QueryEmbedder = {
  model: 'fake-1',
  embed: async (texts) => texts.map((t) => AXES[t] ?? [0, 0, 1, 0]),
};
const row = (tag: string, kind: string, vec: number[], biomes?: string[]): AssetVectorRow => ({ tag, kind, desc: tag, ...(biomes ? { biomes } : {}), vec });
const ROWS: AssetVectorRow[] = [
  row('willow_weeping', 'prop', [0.95, 0.1, 0, 0], ['swamp']),
  row('reeds', 'prop', [0.9, 0, 0.1, 0], ['swamp']),
  row('cactus_saguaro', 'prop', [0.6, 0, 0.6, 0], ['desert']), // ties broken by the biome nudge
  row('barrel', 'prop', [0, 0, 1, 0]),
  row('whale_ribs', 'prop', [0.1, 0.95, 0, 0], ['arctic']),
  row('crocodile', 'character', [0.85, 0.2, 0, 0], ['swamp']),
  row('camel', 'character', [0.1, 0, 0.9, 0], ['desert']),
  row('swamp', 'terrain', [0.9, 0.05, 0, 0], ['swamp']),
  row('sand', 'terrain', [0, 0, 0.9, 0], ['desert']),
];

describe('AssetRetriever — the menu + binding index (Step 2)', () => {
  it('palette partitions by kind, ranks by cosine, and the biome hint NUDGES (never filters)', async () => {
    const r = new AssetRetriever(ROWS, fakeEmbedder);
    const pal = await r.palette('swampy query', { props: 3, chars: 1, terrain: 1, biomeHint: ['swamp'] });
    expect(pal.props.map((p) => p.tag)).toEqual(['willow_weeping', 'reeds', 'cactus_saguaro']); // desert cactus still PRESENT — nudged down, not filtered
    expect(pal.chars.map((c) => c.tag)).toEqual(['crocodile']);
    expect(pal.terrain.map((t) => t.tag)).toEqual(['swamp']);
  });

  it('bind resolves fuzzy concepts to the right kind and REFUSES sub-threshold matches', async () => {
    const r = new AssetRetriever(ROWS, fakeEmbedder);
    const bound = await r.bind(['leviathan-skeleton'], 'prop'); // embeds as 'leviathan skeleton'
    expect(bound['leviathan-skeleton']).toBe('whale_ribs');
    const refused = await r.bind(['utter nonsense zzz'], 'prop'); // orthogonal to every prop
    expect(refused['utter nonsense zzz']).toBeUndefined(); // a wrong confident binding is worse than an honest miss
  });

  it('paletteBlock renders the prompt block; loadAssetVectors degrades to null or loads well-formed', () => {
    const block = paletteBlock({ props: [{ tag: 'a', desc: 'x' }], chars: [], terrain: [] });
    expect(block).toContain('props: a (x)');
    expect(paletteBlock({ props: [], chars: [], terrain: [] })).toBe('');
    const v = loadAssetVectors();
    if (v) {
      expect(v.model.length).toBeGreaterThan(0);
      expect(v.rows.length).toBeGreaterThan(100);
      expect(v.rows[0]!.vec.length).toBeGreaterThan(10);
    } else {
      expect(v).toBeNull(); // fresh clone: no vectors — retrieval off, everything else unchanged
    }
  });
});

describe('compileSpec semantic bindings — the long-tail fallback AFTER the fast path', () => {
  const spec = (features: SceneSpec['features']): SceneSpec => ({ specVersion: 1, brief: 'x', frame: { grammar: 'wild' }, features });

  it('an unresolvable prop concept binds via opts.bindings (verified isProp) with an honest note', () => {
    const s = spec([{ id: 'levi', kind: 'prop.ancient-sundial', geom: 'point' }]);
    const miss = compileSpec(s, { settlement: false });
    expect(miss.unrepresented.join(',')).toContain('sundial');
    const hit = compileSpec(s, { settlement: false, bindings: { props: { 'ancient-sundial': 'whale_ribs' } } });
    expect(hit.postOps.some((o) => o.op === 'place' && o.tag === 'whale_ribs')).toBe(true);
    expect(hit.unrepresented).toHaveLength(0);
    expect(hit.notes.join(' ')).toContain('bound semantically');
  });

  it('an actor binding only overrides the GENERIC villager fallback, never a specific table hit', () => {
    // marsh-strider: no table row → villager → binding wins.
    const generic = compileSpec(spec([{ id: 'ms', kind: 'actor.marsh-strider', geom: 'point' }]), {
      settlement: false, bindings: { actors: { 'marsh-strider': 'heron' } },
    });
    expect(generic.postOps.some((o) => o.op === 'scatter' && o.tags?.includes('heron'))).toBe(true);
    // winter-wolf: LOOK_SYNONYMS hit → a conflicting binding must be IGNORED.
    const specific = compileSpec(spec([{ id: 'ww', kind: 'actor.winter-wolf', geom: 'point' }]), {
      settlement: false, bindings: { actors: { 'winter-wolf': 'camel' } },
    });
    expect(specific.postOps.some((o) => o.op === 'scatter' && o.tags?.includes('wolf_winter'))).toBe(true);
    expect(specific.postOps.some((o) => o.op === 'scatter' && o.tags?.includes('camel'))).toBe(false);
  });

  it('unresolvedSpecConcepts returns exactly the fast-path misses (not buildings/docks/resolvables)', () => {
    const s = spec([
      { id: 'a', kind: 'prop.ancient-sundial', geom: 'point' }, // miss → listed
      { id: 'b', kind: 'prop.lamp-post', geom: 'point' }, // synonym hit → not listed
      { id: 'c', kind: 'building.boathouse', geom: 'region' }, // building path → not listed
      { id: 'd', kind: 'dock.jetty', geom: 'network' }, // frontier path → not listed
      { id: 'e', kind: 'actor.marsh-strider', geom: 'point' }, // villager fallback → listed
      { id: 'f', kind: 'actor.winter-wolf', geom: 'point' }, // table hit → not listed
    ]);
    const un = unresolvedSpecConcepts(s);
    expect(un.props).toEqual(['ancient-sundial']);
    expect(un.actors).toEqual(['marsh-strider']);
  });
});

describe('review fixes — the palette/binding hazards the adversarial review confirmed', () => {
  const spec = (features: SceneSpec['features']): SceneSpec => ({ specVersion: 1, brief: 'x', frame: { grammar: 'wild' }, features });

  it('terrain.* concepts are NEVER prop-bound: not listed as unresolved, and bindings are ignored', () => {
    const s = spec([{ id: 'bank', kind: 'terrain.riverbank', geom: 'region' }]);
    expect(unresolvedSpecConcepts(s).props).toEqual([]); // never sent to the retriever
    const r = compileSpec(s, { settlement: false, bindings: { props: { riverbank: 'weir' } } });
    expect(r.postOps.some((o) => o.op === 'place' && o.tag === 'weir')).toBe(false); // a forced binding is ignored
    expect(r.notes.join(' ')).toContain("base terrain (programmer's brief)"); // the honest pre-change note survives
  });

  it('a verbatim tag-form ACTOR kind resolves to the EXACT sprite, not a substring row', () => {
    // pre-fix: actor.giant_frost fell into lookToSprite's /giants?/ row -> giant_hill (silent wrong monster)
    const r = compileSpec(spec([{ id: 'fg', kind: 'actor.giant_frost', geom: 'point' }]), { settlement: false });
    expect(r.postOps.some((o) => o.op === 'scatter' && o.tags?.includes('giant_frost'))).toBe(true);
    expect(r.postOps.some((o) => o.op === 'scatter' && o.tags?.includes('giant_hill'))).toBe(false);
  });

  it('the programmer palette rides a MODEL-ONLY channel: the LLM sees it, the harvest nets never do', async () => {
    // The palette offers wolf_winter ("a winter wolf...") — pre-fix, normalizeProgram's creature net
    // read that desc as fiction and injected a wolf pack into this peaceful clearing.
    const seen: string[] = [];
    const fakeLlm = {
      complete: async (req: { messages: { content: string }[] }) => {
        seen.push(req.messages[0]!.content);
        return { text: '{"cols":30,"rows":20,"grammar":"open-outdoor","outdoor":true,"ops":[]}', costUsd: 0 };
      },
    };
    const palette = 'AVAILABLE ART (retrieved)\n  creatures: wolf_winter (a winter wolf, white-ruffed), skeleton (walking bones)';
    const prog = await new LlmSceneProgrammer(fakeLlm as never).compose('a quiet forest clearing at noon', 'calm day', undefined, palette);
    expect(seen[0]).toContain('AVAILABLE ART'); // the model DID receive the menu
    const mobTags = prog.ops.filter((o) => o.op === 'scatter' && o.role === 'mob').flatMap((o) => (o as { tags?: string[] }).tags ?? []);
    expect(mobTags).toEqual([]); // and the deterministic nets injected NOTHING from it
  });
});
