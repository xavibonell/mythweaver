/**
 * Contract validators (docs/SCENE-CONTRACTS.md) — the deterministic INVARIANTS for each
 * boundary artifact. These are the "tests" half of every contract; LLM-graded "quality"
 * lives in the eval harness. Pure + dependency-free (the catalog is passed in, so this
 * package stays free of the scene/art packages).
 *
 *   A  validateEstablishScene  (DM output)
 *   B  validateComposition     (Director output, vs the establish + party it must cover)
 *   C  validateSceneMap        (frozen object_map — the consistency guarantor)
 *   E  validateDelta           (manipulation op; shaped now, wired later)
 */

import { FEET_PER_TILE } from './scene.js';
import {
  GRAMMAR_ZONES,
  GRID_LIMITS,
  LAYOUT_GRAMMARS,
  isEntityId,
  isValidAnchor,
  type ActorRole,
  type EntityKind,
  type EstablishScene,
  type LayoutGrammar,
  type PartyMemberRef,
  type SceneComposition,
  type SceneDelta,
  type SceneMap,
} from './world.js';

export interface ContractViolation {
  code: string;
  message: string;
  path?: string;
}
export interface ValidationResult {
  ok: boolean;
  violations: ContractViolation[];
}

/** Tag/biome vocabularies the artifacts are checked against (the catalog, passed in). */
export interface CatalogSets {
  tags: ReadonlySet<string>;
  biomes: ReadonlySet<string>;
}

const LIGHTINGS = new Set(['day', 'dusk', 'night']);
/** The id prefix is the canonical kind/role hint; validators cross-check the explicit field against it. */
const KIND_BY_PREFIX: Record<string, EntityKind> = { bldg: 'fixture', prop: 'prop', npc: 'actor', pc: 'actor', mob: 'actor' };
const ROLE_BY_PREFIX: Record<string, ActorRole> = { npc: 'npc', pc: 'pc', mob: 'mob' };

function done(violations: ContractViolation[]): ValidationResult {
  return { ok: violations.length === 0, violations };
}
function prefixOf(id: string): string {
  return id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
}

// ---------------------------------------------------------------------------
// A — EstablishScene (DM → Director): the fiction. Semantic only, no coordinates.
// ---------------------------------------------------------------------------

export function validateEstablishScene(e: EstablishScene, cat: CatalogSets): ValidationResult {
  const v: ContractViolation[] = [];
  if (prefixOf(e.locationId) !== 'loc' || !isEntityId(e.locationId)) {
    v.push({ code: 'bad-location-id', message: `locationId must be "loc:<slug>" (got "${e.locationId}")`, path: 'locationId' });
  }
  if (!cat.biomes.has(e.brief?.biome)) v.push({ code: 'bad-biome', message: `unknown biome "${e.brief?.biome}"`, path: 'brief.biome' });
  if (!LIGHTINGS.has(e.brief?.timeOfDay)) v.push({ code: 'bad-lighting', message: `timeOfDay must be day|dusk|night`, path: 'brief.timeOfDay' });
  if (!e.brief?.setting?.trim()) v.push({ code: 'empty-setting', message: 'brief.setting is required', path: 'brief.setting' });

  const ids = new Set<string>();
  const allIds = new Set<string>([...(e.fixtures ?? []).map((f) => f.id), ...(e.npcs ?? []).map((n) => n.id)]);
  const dup = (id: string, path: string) => {
    if (ids.has(id)) v.push({ code: 'dup-id', message: `duplicate id "${id}"`, path });
    ids.add(id);
  };

  for (const [i, f] of (e.fixtures ?? []).entries()) {
    const path = `fixtures[${i}]`;
    if (!isEntityId(f.id) || !['bldg', 'prop'].includes(prefixOf(f.id))) v.push({ code: 'bad-id', message: `fixture id must be "bldg:" or "prop:" (got "${f.id}")`, path });
    dup(f.id, path);
    const expKind = prefixOf(f.id) === 'bldg' ? 'fixture' : prefixOf(f.id) === 'prop' ? 'prop' : null;
    if (expKind && f.kind !== expKind) v.push({ code: 'kind-prefix-mismatch', message: `id "${f.id}" implies kind "${expKind}" but kind is "${f.kind}"`, path: `${path}.kind` });
    if (!cat.tags.has(f.tag)) v.push({ code: 'unknown-tag', message: `unknown tag "${f.tag}"`, path: `${path}.tag` });
    if (f.anchor !== undefined && !isValidAnchor(f.anchor, { knownIds: allIds })) v.push({ code: 'bad-anchor', message: `invalid anchor "${f.anchor}"`, path: `${path}.anchor` });
    if ('col' in (f as object) || 'row' in (f as object)) v.push({ code: 'coords-forbidden', message: 'fixtures must use anchors, not coordinates', path });
  }
  for (const [i, n] of (e.npcs ?? []).entries()) {
    const path = `npcs[${i}]`;
    if (!isEntityId(n.id) || prefixOf(n.id) !== 'npc') v.push({ code: 'bad-id', message: `npc id must be "npc:<slug>" (got "${n.id}")`, path });
    dup(n.id, path);
    if (!n.name?.trim()) v.push({ code: 'empty-name', message: 'npc.name is required', path: `${path}.name` });
    if (typeof n.visible !== 'boolean') v.push({ code: 'bad-visible', message: 'npc.visible must be boolean', path: `${path}.visible` });
    if (n.anchor !== undefined && !isValidAnchor(n.anchor, { knownIds: allIds })) v.push({ code: 'bad-anchor', message: `invalid anchor "${n.anchor}"`, path: `${path}.anchor` });
    if ('col' in (n as object) || 'row' in (n as object)) v.push({ code: 'coords-forbidden', message: 'npcs must use anchors, not coordinates', path });
  }
  return done(v);
}

// ---------------------------------------------------------------------------
// B — SceneComposition (Director → Cartographer): semantic layout covering all entities.
// ---------------------------------------------------------------------------

export function validateComposition(c: SceneComposition, e: EstablishScene, party: PartyMemberRef[], cat: CatalogSets): ValidationResult {
  const v: ContractViolation[] = [];
  if (!(LAYOUT_GRAMMARS as readonly string[]).includes(c.grammar)) {
    v.push({ code: 'bad-grammar', message: `unknown grammar "${c.grammar}"`, path: 'grammar' });
  }
  if (!cat.biomes.has(c.biome)) v.push({ code: 'bad-biome', message: `unknown biome "${c.biome}"`, path: 'biome' });
  if (!LIGHTINGS.has(c.lighting)) v.push({ code: 'bad-lighting', message: 'lighting must be day|dusk|night', path: 'lighting' });
  const zones = GRAMMAR_ZONES[c.grammar as LayoutGrammar] ?? [];
  const { minCols, maxCols, minRows, maxRows } = GRID_LIMITS;
  if (!(c.grid?.cols >= minCols && c.grid.cols <= maxCols)) v.push({ code: 'bad-grid', message: `cols must be ${minCols}..${maxCols}`, path: 'grid.cols' });
  if (!(c.grid?.rows >= minRows && c.grid.rows <= maxRows)) v.push({ code: 'bad-grid', message: `rows must be ${minRows}..${maxRows}`, path: 'grid.rows' });

  if (!cat.tags.has(c.terrain?.base)) v.push({ code: 'unknown-tag', message: `unknown base terrain "${c.terrain?.base}"`, path: 'terrain.base' });
  for (const [i, r] of (c.terrain?.regions ?? []).entries()) {
    if (!cat.tags.has(r.tag)) v.push({ code: 'unknown-tag', message: `unknown terrain "${r.tag}"`, path: `terrain.regions[${i}].tag` });
    if (!zones.includes(r.zone)) v.push({ code: 'bad-zone', message: `zone "${r.zone}" not in grammar "${c.grammar}"`, path: `terrain.regions[${i}].zone` });
  }

  // Every declared entity AND every party member must be placed exactly once — no more, no less.
  const required = new Set<string>([...(e.fixtures ?? []).map((f) => f.id), ...(e.npcs ?? []).map((n) => n.id), ...party.map((p) => p.id)]);
  const placed = new Set<string>();
  for (const [i, p] of (c.placements ?? []).entries()) {
    const path = `placements[${i}]`;
    if (placed.has(p.id)) v.push({ code: 'dup-placement', message: `entity "${p.id}" placed more than once`, path });
    placed.add(p.id);
    if (!required.has(p.id)) v.push({ code: 'unknown-placement', message: `placement for unknown entity "${p.id}"`, path });
    if (!zones.includes(p.zone)) v.push({ code: 'bad-zone', message: `zone "${p.zone}" not in grammar "${c.grammar}"`, path: `${path}.zone` });
    if (p.anchor !== undefined && !isValidAnchor(p.anchor, { grammar: c.grammar as LayoutGrammar, knownIds: required })) {
      v.push({ code: 'bad-anchor', message: `invalid anchor "${p.anchor}"`, path: `${path}.anchor` });
    }
    // The Director's concretized render-spec must be valid + agree with the id prefix.
    if (!cat.tags.has(p.tag)) v.push({ code: 'unknown-tag', message: `unknown tag "${p.tag}"`, path: `${path}.tag` });
    if (!['fixture', 'prop', 'actor'].includes(p.kind)) v.push({ code: 'bad-kind', message: `invalid kind "${p.kind}"`, path: `${path}.kind` });
    if (typeof p.visible !== 'boolean') v.push({ code: 'bad-visible', message: 'visible must be boolean', path: `${path}.visible` });
    const pref = prefixOf(p.id);
    if (KIND_BY_PREFIX[pref] && p.kind !== KIND_BY_PREFIX[pref]) v.push({ code: 'kind-prefix-mismatch', message: `id "${p.id}" implies kind "${KIND_BY_PREFIX[pref]}" but kind is "${p.kind}"`, path: `${path}.kind` });
    if (p.kind === 'actor' && p.role && ROLE_BY_PREFIX[pref] && p.role !== ROLE_BY_PREFIX[pref]) {
      v.push({ code: 'role-prefix-mismatch', message: `id "${p.id}" implies role "${ROLE_BY_PREFIX[pref]}" but role is "${p.role}"`, path: `${path}.role` });
    }
  }
  for (const id of required) if (!placed.has(id)) v.push({ code: 'missing-placement', message: `entity "${id}" was not placed`, path: 'placements' });

  const d = c.ambiance?.density;
  if (!(typeof d === 'number' && d >= 0 && d <= 1)) v.push({ code: 'bad-density', message: 'ambiance.density must be 0..1', path: 'ambiance.density' });
  for (const [i, t] of (c.ambiance?.tags ?? []).entries()) if (!cat.tags.has(t)) v.push({ code: 'unknown-tag', message: `unknown ambiance tag "${t}"`, path: `ambiance.tags[${i}]` });
  return done(v);
}

// ---------------------------------------------------------------------------
// C — SceneMap (frozen object_map): the consistency guarantor. Pure geometry invariants.
// ---------------------------------------------------------------------------

export function validateSceneMap(m: SceneMap, cat?: { tags?: ReadonlySet<string>; biomes?: ReadonlySet<string> }): ValidationResult {
  const v: ContractViolation[] = [];
  const cols = m.grid?.cols ?? 0;
  const rows = m.grid?.rows ?? 0;
  if (!(cols > 0 && rows > 0)) v.push({ code: 'bad-grid', message: 'grid cols/rows must be > 0', path: 'grid' });
  if (m.grid?.feetPerTile !== FEET_PER_TILE) v.push({ code: 'bad-scale', message: `grid.feetPerTile must be ${FEET_PER_TILE}`, path: 'grid.feetPerTile' });
  if (!(LAYOUT_GRAMMARS as readonly string[]).includes(m.grammar)) v.push({ code: 'bad-grammar', message: `unknown grammar "${m.grammar}"`, path: 'grammar' });
  // The frozen map is the source of truth feeding renderer + DM digest — validate its identity/vocab too.
  if (prefixOf(m.locationId) !== 'loc' || !isEntityId(m.locationId)) v.push({ code: 'bad-location-id', message: `locationId must be "loc:<slug>" (got "${m.locationId}")`, path: 'locationId' });
  if (!LIGHTINGS.has(m.lighting)) v.push({ code: 'bad-lighting', message: `lighting must be day|dusk|night (got "${m.lighting}")`, path: 'lighting' });
  if (cat?.biomes && !cat.biomes.has(m.biome)) v.push({ code: 'bad-biome', message: `unknown biome "${m.biome}"`, path: 'biome' });

  // tiles/walkable dimensions must match the grid exactly.
  if (m.tiles?.length !== rows) v.push({ code: 'tiles-rows', message: `tiles has ${m.tiles?.length} rows, expected ${rows}`, path: 'tiles' });
  if (m.walkable?.length !== rows) v.push({ code: 'walkable-rows', message: `walkable has ${m.walkable?.length} rows, expected ${rows}`, path: 'walkable' });
  for (let r = 0; r < rows; r++) {
    if (m.tiles?.[r]?.length !== cols) v.push({ code: 'tiles-cols', message: `tiles[${r}] width != ${cols}`, path: `tiles[${r}]` });
    if (m.walkable?.[r]?.length !== cols) v.push({ code: 'walkable-cols', message: `walkable[${r}] width != ${cols}`, path: `walkable[${r}]` });
    for (let c = 0; c < cols; c++) {
      const t = m.tiles?.[r]?.[c];
      if (!t) v.push({ code: 'empty-tile', message: `tiles[${r}][${c}] is empty`, path: `tiles[${r}][${c}]` });
      else if (cat?.tags && !cat.tags.has(t)) v.push({ code: 'unknown-tag', message: `unknown terrain tag "${t}"`, path: `tiles[${r}][${c}]` });
    }
  }

  const within = (col: number, row: number) => col >= 0 && col < cols && row >= 0 && row < rows;
  const walkAt = (col: number, row: number) => within(col, row) && m.walkable?.[row]?.[col] === true;

  const ids = new Set<string>();
  const fixtureRects: { id: string; x: number; y: number; w: number; h: number }[] = [];
  for (const [i, o] of (m.objects ?? []).entries()) {
    const path = `objects[${i}]`;
    if (!isEntityId(o.id)) v.push({ code: 'bad-id', message: `invalid entity id "${o.id}"`, path });
    if (ids.has(o.id)) v.push({ code: 'dup-id', message: `duplicate object id "${o.id}"`, path });
    ids.add(o.id);
    if (!['fixture', 'prop', 'actor'].includes(o.kind)) v.push({ code: 'bad-kind', message: `invalid kind "${o.kind}"`, path: `${path}.kind` });
    if (o.kind === 'actor' && !o.role) v.push({ code: 'missing-role', message: 'actors must have a role', path: `${path}.role` });
    if (o.kind !== 'actor' && o.role) v.push({ code: 'stray-role', message: 'only actors have a role', path: `${path}.role` });
    const pref = prefixOf(o.id);
    if (KIND_BY_PREFIX[pref] && o.kind !== KIND_BY_PREFIX[pref]) v.push({ code: 'kind-prefix-mismatch', message: `id "${o.id}" implies kind "${KIND_BY_PREFIX[pref]}" but kind is "${o.kind}"`, path: `${path}.kind` });
    if (o.kind === 'actor' && o.role && ROLE_BY_PREFIX[pref] && o.role !== ROLE_BY_PREFIX[pref]) {
      v.push({ code: 'role-prefix-mismatch', message: `id "${o.id}" implies role "${ROLE_BY_PREFIX[pref]}" but role is "${o.role}"`, path: `${path}.role` });
    }
    if (typeof o.visible !== 'boolean') v.push({ code: 'bad-visible', message: 'visible must be boolean', path: `${path}.visible` });
    const w = o.footprint?.w ?? 0;
    const h = o.footprint?.h ?? 0;
    if (!(w >= 1 && h >= 1)) v.push({ code: 'bad-footprint', message: 'footprint w/h must be >= 1', path: `${path}.footprint` });
    if (!within(o.col, o.row) || !within(o.col + w - 1, o.row + h - 1)) {
      v.push({ code: 'out-of-bounds', message: `object "${o.id}" footprint exceeds grid`, path });
    }
    // Actors must stand on walkable tiles across their whole footprint (lurkers included).
    if (o.kind === 'actor') {
      let blocked = false;
      for (let dy = 0; dy < h && !blocked; dy++) for (let dx = 0; dx < w && !blocked; dx++) if (!walkAt(o.col + dx, o.row + dy)) blocked = true;
      if (blocked) v.push({ code: 'actor-blocked', message: `actor "${o.id}" overlaps a non-walkable tile`, path });
    }
    if (o.kind === 'fixture') fixtureRects.push({ id: o.id, x: o.col, y: o.row, w, h });
  }
  // Fixtures may not overlap each other.
  for (let i = 0; i < fixtureRects.length; i++) {
    for (let j = i + 1; j < fixtureRects.length; j++) {
      const a = fixtureRects[i]!;
      const b = fixtureRects[j]!;
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
        v.push({ code: 'fixture-overlap', message: `fixtures "${a.id}" and "${b.id}" overlap`, path: 'objects' });
      }
    }
  }

  for (const [i, a] of (m.ambiance ?? []).entries()) if (!within(a.col, a.row)) v.push({ code: 'out-of-bounds', message: `ambiance[${i}] off-grid`, path: `ambiance[${i}]` });
  for (const [i, en] of (m.entrances ?? []).entries()) {
    const path = `entrances[${i}]`;
    if (prefixOf(en.toLocationId) !== 'loc') v.push({ code: 'bad-location-id', message: `entrance.toLocationId must be "loc:<slug>"`, path: `${path}.toLocationId` });
    if (!walkAt(en.col, en.row)) v.push({ code: 'entrance-blocked', message: `entrance "${en.toLocationId}" is not on a walkable tile`, path });
  }
  return done(v);
}

// ---------------------------------------------------------------------------
// E — SceneDelta (manipulation): light shape check (full wiring is a later phase).
// ---------------------------------------------------------------------------

export function validateDelta(d: SceneDelta): ValidationResult {
  const v: ContractViolation[] = [];
  if (!isEntityId(d.id)) v.push({ code: 'bad-id', message: `invalid entity id "${d.id}"`, path: 'id' });
  if (d.op === 'move') {
    const t = d.to as { anchor?: string; col?: number; row?: number };
    const okAnchor = typeof t.anchor === 'string' && isValidAnchor(t.anchor);
    const okTile = Number.isInteger(t.col) && Number.isInteger(t.row);
    if (!okAnchor && !okTile) v.push({ code: 'bad-target', message: 'move.to must be {anchor} or {col,row}', path: 'to' });
  } else if (d.op === 'spawn') {
    if (!['fixture', 'prop', 'actor'].includes(d.kind)) v.push({ code: 'bad-kind', message: `invalid kind "${d.kind}"`, path: 'kind' });
    if (!isValidAnchor(d.anchor)) v.push({ code: 'bad-anchor', message: `invalid anchor "${d.anchor}"`, path: 'anchor' });
  } else if (d.op === 'enter') {
    if (prefixOf(d.toLocationId) !== 'loc' || !isEntityId(d.toLocationId)) v.push({ code: 'bad-location-id', message: 'enter.toLocationId must be "loc:<slug>"', path: 'toLocationId' });
    if (d.via !== undefined && !isEntityId(d.via)) v.push({ code: 'bad-id', message: 'invalid via id', path: 'via' });
  }
  return done(v);
}
