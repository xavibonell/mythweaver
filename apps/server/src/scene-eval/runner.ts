/**
 * Scene eval runner — drives each brief through the REAL setup pipeline (DM setScene → Director →
 * Cartographer, via labBuildScene), runs deterministic invariants (the hard regression gate), and
 * LLM-judges the composition. Providers come from env (parity with prod). Makes real API calls.
 */

import { AnthropicProvider, createProvider, type LlmProvider } from '@mythweaver/llm';
import { CHARACTERS, FakeSceneComposer, LlmSceneComposer, PROPS, TERRAINS, type SceneComposer } from '@mythweaver/scene';
import { validateSceneMap, type PartyMemberRef } from '@mythweaver/shared';
import { labBuildScene, type LabResult } from '../scene-lab.js';
import { SCENE_EVAL_CASES, type SceneEvalCase, type SceneExpectation } from './cases.js';
import { judgeScene, SCENE_RUBRIC, type SceneScores } from './rubric.js';

const CATALOG = { tags: new Set([...TERRAINS, ...PROPS, ...CHARACTERS].map((x) => x.tag)) };
// No injected party — like the lab, the cast comes from each brief's own declared characters.
const NO_PARTY: PartyMemberRef[] = [];

export interface InvariantResult {
  ok: boolean;
  failures: string[];
}
export interface SceneCaseResult {
  id: string;
  scores: SceneScores;
  invariants: InvariantResult;
  summary: string; // one-line scene shape, for the report
}
export interface SceneEvalReport {
  perCase: SceneCaseResult[];
  means: SceneScores;
  runs: number;
  invariantFailures: string[];
}

/** Deterministic composition invariants — the hard gate, independent of the fuzzy judge. */
export function checkInvariants(r: LabResult, expect: SceneExpectation): InvariantResult {
  const m = r.sceneMap;
  const f: string[] = [];
  const v = validateSceneMap(m, CATALOG);
  if (!v.ok) f.push(`invalid SceneMap: ${v.violations.map((x) => x.code).join(', ')}`);
  if (expect.grammar && m.grammar !== expect.grammar) f.push(`grammar "${m.grammar}" != "${expect.grammar}"`);
  const tags = new Set(m.objects.map((o) => o.tag));
  for (const t of expect.mustRenderTags ?? []) if (!tags.has(t)) f.push(`missing required tag "${t}"`);
  if (expect.fountainCentered) {
    const fo = m.objects.find((o) => o.tag === 'fountain');
    if (!fo) f.push('expected a fountain, none placed');
    else if (Math.abs(fo.col - m.grid.cols / 2) > 4 || Math.abs(fo.row - m.grid.rows / 2) > 5) f.push(`fountain not centred (at ${fo.col},${fo.row} of ${m.grid.cols}x${m.grid.rows})`);
  }
  if (expect.noAmbiance && m.ambiance.length > 0) f.push(`interior should have no ambiance, found ${m.ambiance.length}`);
  const cells = new Set(m.objects.map((o) => `${o.col},${o.row}`));
  if (m.objects.length >= 4 && cells.size < m.objects.length * 0.7) f.push(`objects piling: ${cells.size} distinct cells for ${m.objects.length} objects`);
  for (const o of m.objects) if (o.kind === 'actor' && m.walkable[o.row]?.[o.col] !== true) f.push(`actor ${o.id} on a non-walkable tile (${o.col},${o.row})`);
  // Spatial-fidelity gates (blockout): orientation of the path + density of the treeline edges.
  const { cols, rows } = m.grid;
  if (expect.pathOrientation === 'horizontal') {
    const ok = m.tiles.some((row) => row.filter((t) => t === 'dirt').length >= cols * 0.6);
    if (!ok) f.push('expected a HORIZONTAL dirt path (a near-full row of dirt), none found');
  }
  if (expect.pathOrientation === 'vertical') {
    let ok = false;
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let r = 0; r < rows; r++) if (m.tiles[r]?.[c] === 'dirt') n++;
      if (n >= rows * 0.6) ok = true;
    }
    if (!ok) f.push('expected a VERTICAL dirt path (a near-full column of dirt), none found');
  }
  if (expect.treelineEdges?.length) {
    const treeCells = new Set([...m.ambiance, ...m.objects].filter((x) => /tree|pine|bush/.test(x.tag)).map((x) => `${x.col},${x.row}`));
    const th = Math.max(2, Math.floor(rows * 0.18)); // top/bottom band thickness
    const sw = Math.max(2, Math.floor(cols * 0.16)); // left/right band thickness
    const band = (edge: string): [number, number, number, number] =>
      edge === 'top' ? [0, 0, cols, th] : edge === 'bottom' ? [0, rows - th, cols, th] : edge === 'left' ? [0, 0, sw, rows] : [cols - sw, 0, sw, rows];
    for (const edge of expect.treelineEdges) {
      const [x, y, w, h] = band(edge);
      let total = 0;
      let trees = 0;
      for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) { total++; if (treeCells.has(`${c},${r}`)) trees++; }
      const frac = total ? trees / total : 0;
      if (frac < 0.5) f.push(`${edge} edge is not a dense treeline (${Math.round(frac * 100)}% trees, need ≥50%)`);
    }
  }
  return { ok: f.length === 0, failures: f };
}

/** A single legend char for a terrain tag, so the judge can SEE the layout (path orientation etc.). */
function terrainChar(tag: string): string {
  const t = tag.toLowerCase();
  if (t.includes('wall')) return 'X';
  if (t.includes('water')) return '~';
  if (t.includes('dirt') || t.includes('path') || t.includes('road') || t.includes('sand')) return '=';
  if (t.includes('stone') || t.includes('cobble') || t.includes('plaza') || t.includes('floor') || t.includes('tile')) return '#';
  if (t.includes('wood') || t.includes('plank')) return '_';
  if (t.includes('grass') || t.includes('moss')) return '.';
  return '?';
}

/**
 * A top-down ASCII rendering of the frozen map: terrain as legend chars, objects/ambiance overlaid.
 * This is what lets the judge assess SPATIAL intent (is the path horizontal? is the treeline a thick
 * band? are the party on the left?) — terrain counts alone can't show orientation.
 */
function asciiMap(r: LabResult): string {
  const m = r.sceneMap;
  const grid: string[][] = m.tiles.map((row) => row.map((t) => terrainChar(t)));
  for (const a of m.ambiance) {
    const row = grid[a.row];
    if (row && row[a.col] !== undefined) row[a.col] = /tree|pine|bush|shrub/i.test(a.tag) ? 't' : ',';
  }
  for (const o of m.objects) {
    const row = grid[o.row];
    if (row && row[o.col] !== undefined) row[o.col] = o.kind === 'actor' ? '@' : 'o';
  }
  return grid.map((row) => row.join('')).join('\n');
}

function digest(r: LabResult): string {
  const m = r.sceneMap;
  const tcounts = new Map<string, number>();
  for (const row of m.tiles) for (const t of row) tcounts.set(t, (tcounts.get(t) ?? 0) + 1);
  const terrain = [...tcounts.entries()].map(([t, n]) => `${t} ${n}`).join(', ');
  const objs = m.objects.map((o) => `  ${o.id} · ${o.kind} · ${o.tag} · zone=${o.zone ?? '-'} · (${o.col},${o.row}) · ${o.visible ? 'visible' : 'hidden'}`).join('\n');
  return `Grammar: ${m.grammar} | biome: ${m.biome} | lighting: ${m.lighting} | grid ${m.grid.cols}x${m.grid.rows}
Terrain tiles: ${terrain}
Top-down map (legend: .=grass =:path/dirt ~=water #=stone/floor _=wood X=wall t=tree ,=decor @=actor o=prop; origin top-left):
${asciiMap(r)}
Objects (${m.objects.length}):
${objs}
Ambiance: ${m.ambiance.length} scattered decor item(s)
DM narration: ${r.narration || '(none)'}`;
}

function buildDeps(): { llm: LlmProvider; composer: SceneComposer; model?: string; judge: LlmProvider } {
  const dmProvider = (process.env.MYTHWEAVER_DM_PROVIDER || 'anthropic').toLowerCase();
  const dmModel = process.env.MYTHWEAVER_DM_MODEL || undefined;
  const llm = createProvider(dmProvider, dmModel ? { model: dmModel } : {});
  const dirName = (process.env.MYTHWEAVER_SCENE_DIRECTOR || 'fake').toLowerCase();
  const dirModel = process.env.MYTHWEAVER_DIRECTOR_MODEL || undefined;
  const composer = dirName === 'fake' || dirName === '' || dirName === 'none' ? new FakeSceneComposer() : new LlmSceneComposer(createProvider(dirName, dirModel ? { model: dirModel } : {}), dirModel);
  return { llm, composer, model: dmModel, judge: new AnthropicProvider() };
}

async function runSceneCase(c: SceneEvalCase, deps: ReturnType<typeof buildDeps>, party: PartyMemberRef[]): Promise<SceneCaseResult> {
  const result = await labBuildScene({ llm: deps.llm, composer: deps.composer, ...(deps.model ? { model: deps.model } : {}) }, c.brief, party);
  const invariants = checkInvariants(result, c.expect);
  const scores = await judgeScene(deps.judge, { brief: c.brief, digest: digest(result) });
  const m = result.sceneMap;
  const summary = `${m.grammar} · ${m.grid.cols}x${m.grid.rows} · ${m.objects.length} objects · ${m.ambiance.length} ambiance`;
  return { id: c.id, scores, invariants, summary };
}

export async function runSceneEvals(opts: { runs?: number } = {}): Promise<SceneEvalReport> {
  const runs = Math.max(1, opts.runs ?? 1);
  const deps = buildDeps();
  const perCase: SceneCaseResult[] = [];
  for (let r = 0; r < runs; r++) {
    for (const c of SCENE_EVAL_CASES) {
      // eslint-disable-next-line no-await-in-loop
      perCase.push(await runSceneCase(c, deps, NO_PARTY));
    }
  }
  const means = {} as SceneScores;
  for (const d of SCENE_RUBRIC) means[d.key] = perCase.reduce((s, x) => s + x.scores[d.key], 0) / perCase.length;
  const invariantFailures = perCase.flatMap((x) => x.invariants.failures.map((fl) => `${x.id}: ${fl}`));
  return { perCase, means, runs, invariantFailures };
}
