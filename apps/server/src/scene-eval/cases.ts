/**
 * Scene eval cases — briefs across biomes/grammars, each with deterministic expectations the
 * runner asserts (the hard regression gate) plus the LLM-judged composition score. Keep this set
 * small + representative; it makes real DM + Director calls (costs money).
 */

export interface SceneExpectation {
  /** The layout grammar the brief should route to (structural, biome-derived). */
  grammar?: 'town-square' | 'enclosed-interior' | 'open-outdoor';
  /** Tags that MUST appear in the frozen object_map (brief coverage). */
  mustRenderTags?: string[];
  /** Town-square centrepiece: a fountain placed near the grid centre. */
  fountainCentered?: boolean;
  /** No ambiance allowed (interiors must not scatter outdoor decor). */
  noAmbiance?: boolean;
  /** A dirt path must run in this orientation (blockout): a near-full row (horizontal) or column (vertical). */
  pathOrientation?: 'horizontal' | 'vertical';
  /** These screen edges must be a dense treeline (≥ half the edge band filled with trees). */
  treelineEdges?: ('top' | 'bottom' | 'left' | 'right')[];
}

export interface SceneEvalCase {
  id: string;
  brief: string;
  expect: SceneExpectation;
  note: string;
}

export const SCENE_EVAL_CASES: SceneEvalCase[] = [
  {
    id: 'seaside-village',
    brief: 'A lively village by the sea with houses all around, a market with stalls, animals roaming, and a central square with a fountain.',
    expect: { grammar: 'town-square', mustRenderTags: ['fountain'], fountainCentered: true },
    note: 'town-square: fountain centred, houses lining the square, animals, sea',
  },
  {
    id: 'market-square',
    brief: 'A bustling market square at midday: stalls, crates and barrels, a blacksmith’s forge. A merchant, a guard, and a hooded stranger.',
    expect: { grammar: 'town-square', mustRenderTags: ['market_stall'] },
    note: 'town-square market with stalls + crates/barrels',
  },
  {
    id: 'crypt',
    brief: 'A torchlit crypt antechamber: stone sarcophagi, broken pillars, a hanging banner, an archway to the dark. Two skeletons stand guard.',
    expect: { grammar: 'enclosed-interior', mustRenderTags: ['gravestone', 'skeleton'], noAmbiance: true },
    note: 'walled interior: grave markers (no sarcophagus tile in the Kenney set) + skeletons, NO outdoor ambiance',
  },
  {
    id: 'forest-camp',
    brief: 'A forest clearing at night around a campfire: tall pines, a fallen log, scattered rocks. A lone ranger keeps watch.',
    // Trees are now dense AMBIANCE (the blockout's forest fill), not addressable objects — so we no
    // longer require tree_pine in object_map; grammar + the judge cover the "is it a forest" question.
    expect: { grammar: 'open-outdoor' },
    note: 'outdoor forest clearing: dense tree ambiance + a campfire + a watcher',
  },
  // --- Spatial-fidelity cases (Step 1 measurement). These have no hard spatial gate yet — the
  // current pipeline literally can't honor orientation — so they're scored by the judge (spatialSense
  // / briefCoherence) to give a baseline the blockout (Step 2) must beat. See docs/VISUAL-LAYER-TODO.
  {
    id: 'forest-horizontal-path',
    brief: 'A forest environment. The top and bottom of the screen are full, thick lines of trees. Across the middle runs a single straight dirt path going left to right, horizontally, with grass and flowers around it. Our three characters are on the LEFT side of the screen; two goblins guard a chest in the CENTER.',
    expect: { grammar: 'open-outdoor', pathOrientation: 'horizontal', treelineEdges: ['top', 'bottom'] },
    note: 'SPATIAL: horizontal path, thick treeline bands top+bottom, party grouped left, goblins+chest centre',
  },
  {
    id: 'shore-side-orientation',
    // Lever B fixed the routing: a wild "beach"/"coast" now classifies as WILD → open-outdoor (it no
    // longer collapses into a town-square). The judge scores the left/right water fidelity.
    brief: 'A beach at midday. The sea fills the RIGHT third of the screen; dry sand covers the LEFT two thirds. A fisherman stands at the waterline on the right; two crates sit on the sand to the left.',
    expect: { grammar: 'open-outdoor' },
    note: 'SPATIAL: left/right orientation — water on the right; routes to WILD/open-outdoor (not town-square)',
  },
];
