/**
 * SceneSpec — the requirements IR (Weave architecture L0): the contract between DM FICTION and scene
 * GENERATION. The DM/Director emits declarative REQUIREMENTS — features (what exists) + constraints
 * (how they relate, with hard/story/soft weight) + conditions (atmosphere) + tableaux (staged casts) —
 * and NEVER coordinates or sprite tags. A compiler (L1-L5) realizes it and returns a FidelityReport of
 * what it could not honor, which the DM re-narrates. Everything here is CLOSED in code, OPEN in data.
 *
 * This file is the schema + validator only (the R2 falsification measures whether a DM can reliably
 * EMIT this). Closed enums keep emission checkable; the relation set grows only by a kernel RFC.
 */

/** The closed relation vocabulary (v1 = 11). PARTY = the party's entry frame (staging anchor). */
export const SCENE_RELATIONS = [
  'through-fabric', // a network feature threads the whole fabric (a canal through the town)
  'crossable', // a barrier feature must be crossable (bridges derive) — pair with `at`
  'across', // a is on the far side of `via` from b (windows across the water from the party)
  'along', // a runs beside/parallel to b (the shrine along the canal)
  'near', // a within `band` tiles of b
  'side', // a is to the `dir` side of `of`, optionally `paces` away (doorway 3 paces to your right)
  'visible-from', // a has line of sight to b
  'unreachable-from', // a is not walkable-reachable from b (the far bank)
  'facing', // a is oriented toward b (windows facing the party)
  'in', // a is inside region b/`region` (windows in the house row)
  'at-edge-of', // a sits on the edge of region b (a dock at the edge of the plaza)
] as const;
export type SceneRelation = (typeof SCENE_RELATIONS)[number];

export const SCENE_GEOMS = ['network', 'region', 'point', 'edge-profile'] as const;
export type SceneGeom = (typeof SCENE_GEOMS)[number];

/** Region LITERALS a ref may name without declaring a feature — fabric regions every scene owns.
 *  'water' = the scene's water body ("in: water" puts the drowned dead IN the reservoir). Grows only
 *  by kernel RFC, like the relation set. */
export const SCENE_REGION_LITERALS = ['water'] as const;

export const SCENE_GRAMMARS = ['settlement', 'interior', 'wild'] as const;
export type SceneGrammar = (typeof SCENE_GRAMMARS)[number];

/** hard = fails the stage (re-plan or declared degradation) · story = degradable but MUST surface in the
 *  DM digest for re-narration (the "4 shuttered / 1 open windows" case) · soft = maximized, dropped to report. */
export const SCENE_WEIGHTS = ['hard', 'story', 'soft'] as const;
export type SceneWeight = (typeof SCENE_WEIGHTS)[number];

export interface SceneFeature {
  id: string; // slug, unique within the spec ("canal1", "row1", "winShut")
  kind: string; // dotted concept ("waterway.canal", "building.house", "window", "shrine") — open, contract-checked at compile
  geom: SceneGeom;
  count?: number;
  profile?: string; // material/realization profile hint ("water.canal")
  region?: string; // for a point/region feature scoped inside another feature-region
  states?: Record<string, string>; // requested state axes ({ shutter: "closed" })
}

export interface SceneConstraint {
  c: SceneRelation;
  w: SceneWeight;
  f?: string; // the single feature a unary relation applies to (through-fabric/crossable)
  a?: string; // subject (feature id or "PARTY")
  b?: string; // object (feature id or "PARTY")
  region?: string; // region ref for `in`/`at-edge-of`
  via?: string; // the separating feature for `across`
  at?: string; // "circulation" | … for `crossable`
  dir?: 'north' | 'south' | 'east' | 'west' | 'left' | 'right';
  paces?: number;
  band?: [number, number];
  of?: string; // anchor for `side`
}

export interface SceneTableau {
  id: string;
  pattern?: string; // a base pattern ("doorway-figure", "queue")
  macro?: string; // a composite that expands to patterns+roles+constraints ("shrine_ladle_service")
  focus?: string; // feature id the tableau centres on
  roles?: Record<string, unknown>; // cast bindings (validated at compile, opaque here)
}

export interface SceneSpec {
  specVersion: 1;
  seed?: string;
  brief: string; // survives to the narrator verbatim
  frame: { grammar: SceneGrammar; entry?: { edge?: 'north' | 'south' | 'east' | 'west'; pose?: string } };
  conditions?: { profile: string; value?: number; source?: string }[];
  features: SceneFeature[];
  constraints?: SceneConstraint[];
  tableaux?: SceneTableau[];
  narrationOnly?: string[]; // things the engine cannot render; the DM keeps them alive in prose (the unrung bell)
}

export interface SceneSpecReport {
  ok: boolean;
  violations: { code: string; message: string; path?: string }[];
  warnings: { code: string; message: string; path?: string }[];
}

const SLUG = /^[a-z][a-z0-9_]*$/i;
const REL = new Set<string>(SCENE_RELATIONS);
const relArgs: Record<SceneRelation, { unary?: boolean; needsVia?: boolean }> = {
  'through-fabric': { unary: true }, crossable: { unary: true },
  across: { needsVia: false }, along: {}, near: {}, side: {}, 'visible-from': {}, 'unreachable-from': {}, facing: {}, in: {}, 'at-edge-of': {},
};

/** Validate a SceneSpec's SHAPE, closed vocab, reference integrity, and obvious unsatisfiability. Does NOT
 *  check realizability (that's the compiler's fidelity report) — this is the emission gate. */
export function validateSceneSpec(spec: unknown): SceneSpecReport {
  const v: SceneSpecReport['violations'] = [];
  const w: SceneSpecReport['warnings'] = [];
  const bad = (code: string, message: string, path?: string) => v.push({ code, message, ...(path ? { path } : {}) });
  const s = spec as Partial<SceneSpec>;
  if (!s || typeof s !== 'object') return { ok: false, violations: [{ code: 'not-object', message: 'spec is not an object' }], warnings: [] };
  if (s.specVersion !== 1) bad('bad-version', `specVersion must be 1 (got ${JSON.stringify(s.specVersion)})`);
  if (typeof s.brief !== 'string' || !s.brief.trim()) bad('no-brief', 'brief (string) is required');
  if (!s.frame || !(SCENE_GRAMMARS as readonly string[]).includes(s.frame.grammar)) bad('bad-grammar', `frame.grammar must be one of ${SCENE_GRAMMARS.join('|')}`, 'frame');

  const ids = new Set<string>();
  const features = Array.isArray(s.features) ? s.features : [];
  if (!features.length) bad('no-features', 'at least one feature is required');
  features.forEach((f, i) => {
    const p = `features[${i}]`;
    if (!f || typeof f.id !== 'string' || !SLUG.test(f.id)) { bad('bad-feature-id', `feature id must be a slug`, p); return; }
    if (ids.has(f.id)) bad('dup-feature-id', `duplicate feature id "${f.id}"`, p); else ids.add(f.id);
    if (typeof f.kind !== 'string' || !f.kind) bad('bad-kind', `feature "${f.id}" needs a kind`, p);
    if (!(SCENE_GEOMS as readonly string[]).includes(f.geom)) bad('bad-geom', `feature "${f.id}" geom must be one of ${SCENE_GEOMS.join('|')}`, p);
  });
  const ref = (x: string | undefined) => x === undefined || x === 'PARTY' || (SCENE_REGION_LITERALS as readonly string[]).includes(x) || ids.has(x);

  const seenPair = new Map<string, Set<string>>(); // (a,b) → set of hard relations, for unsat detection
  (Array.isArray(s.constraints) ? s.constraints : []).forEach((cn, i) => {
    const p = `constraints[${i}]`;
    if (!cn || !REL.has(cn.c)) { bad('bad-relation', `unknown relation "${cn?.c}" (allowed: ${SCENE_RELATIONS.join(', ')})`, p); return; }
    if (!(SCENE_WEIGHTS as readonly string[]).includes(cn.w)) bad('bad-weight', `weight must be hard|story|soft`, p);
    for (const [k, val] of [['f', cn.f], ['a', cn.a], ['b', cn.b], ['region', cn.region], ['via', cn.via], ['of', cn.of]] as const)
      if (val !== undefined && !ref(val)) bad('dangling-ref', `${p}.${k} "${val}" is not a feature id or PARTY`, p);
    // ERGONOMICS (R2): a binary relation needs a SUBJECT (a); the object DEFAULTS to the PARTY when omitted
    // — the party's entry pose is the scene's staging anchor, so "near"/"facing"/"visible-from" with no
    // object read as "…relative to the party", and "in"/"at-edge-of" with no region read as the frame.
    // This matches how a DM under-specifies and lifts emission over the line without loosening ref integrity
    // (a b/region that IS given still must resolve — see the dangling-ref check above).
    const meta = relArgs[cn.c];
    if (meta.unary) { if (!cn.f && !cn.a) bad('missing-arg', `relation "${cn.c}" needs a target feature (f)`, p); }
    else if (!cn.a && !cn.f) bad('missing-arg', `relation "${cn.c}" needs a subject (a)`, p);
    if (cn.a && cn.b && cn.w === 'hard') { // unsat heuristic: across (far) + near (close), both hard, same unordered pair
      const key = [cn.a, cn.b].sort().join('|');
      const set = seenPair.get(key) ?? new Set<string>(); set.add(cn.c); seenPair.set(key, set);
      if (set.has('across') && set.has('near')) bad('unsat-pair', `hard "across" and "near" on the same pair (${key}) are mutually unsatisfiable`, p);
    }
  });

  (Array.isArray(s.tableaux) ? s.tableaux : []).forEach((t, i) => {
    const p = `tableaux[${i}]`;
    if (!t || typeof t.id !== 'string') bad('bad-tableau', 'tableau needs an id', p);
    if (!t?.pattern && !t?.macro) bad('bad-tableau', `tableau "${t?.id}" needs a pattern or macro`, p);
    if (t?.focus && !ref(t.focus)) bad('dangling-ref', `${p}.focus "${t.focus}" is not a feature id`, p);
  });

  if (s.conditions) s.conditions.forEach((c, i) => { if (typeof c?.profile !== 'string') bad('bad-condition', 'condition needs a profile', `conditions[${i}]`); });
  return { ok: v.length === 0, violations: v, warnings: w };
}
