/**
 * SCENE ARCHITECT (S1 — Weave L0 emission, promoted from the R2 trial): one batched call per
 * campaign that turns each beat's fiction into a SceneSpec — the FUNCTIONAL contract the scene
 * compiler consumes (features + relations + entry staging; no prose, no coordinates). Every spec is
 * gated by validateSceneSpec with ONE repair round; invalid specs are dropped with a warning, never
 * stored. The prompt is editable data (prompts/scene-architect.md), same seam as the playbook.
 */

import { estimateCostUsd, type LlmProvider } from '@mythweaver/llm';
import { SCENE_RELATIONS, validateSceneSpec, type ScenePlan, type SceneSpec } from '@mythweaver/shared';

export const DEFAULT_SCENE_ARCHITECT_SYSTEM = `You are MythWeaver's SCENE ARCHITECT. For EACH beat of a campaign you receive, turn its fiction into a SceneSpec — a declarative REQUIREMENTS document. You describe WHAT must exist and HOW things relate; a deterministic engine owns all geometry. Output ONLY one JSON object, no prose:
{"specs": {"<beatId>": <SceneSpec>, ...}} — one entry per beat, keyed EXACTLY by the given beat id.

SceneSpec shape:
{
  "specVersion": 1,
  "brief": "<one line: the beat's look, verbatim-ish>",
  "frame": { "grammar": "settlement|interior|wild", "entry": { "edge": "north|south|east|west", "pose": "arriving" } },
  "conditions": [ { "profile": "<name>", "value": 0..1 } ],       // atmosphere: abandonment, predawn, fog, festive, flooded…
  "features": [ { "id": "<slug>", "kind": "<dotted concept>", "geom": "network|region|point|edge-profile", "count": <n?>, "states": { "<axis>": "<value>" } } ],
  "constraints": [ { "c": "<relation>", "w": "hard|story|soft", ...refs } ],
  "narrationOnly": [ "<things the engine can't render — keep them in prose>" ]
}

RELATIONS (use ONLY these; nothing else): ${SCENE_RELATIONS.join(', ')}.
  through-fabric{f} · crossable{f, at:"circulation"} · across{a,b,via} · along{a,b} · near{a,b,band:[lo,hi]} · side{a, of, dir:"left|right|north…", paces} · visible-from{a,b} · unreachable-from{a,b} · facing{a,b} · in{a, region} · at-edge-of{a, region}
  Refs (f/a/b/of/region/via) are feature ids OR the literal "PARTY" (the party's entry position). "water" is a legal region for in/at-edge-of (the scene's water body).
WEIGHTS: hard = must hold (geometry) · story = the story depends on it; may degrade but the DM will be told to re-narrate · soft = nice-to-have.

RULES: every ref must resolve to a declared feature id, PARTY, or the region "water" (no dangling refs). You MAY omit the object of near/facing/visible-from/in/at-edge-of — it defaults to the PARTY (or the whole scene). Never put "across" AND "near" both hard on the same pair. Sprite tags and coordinates are FORBIDDEN — only concepts + relations. Unrenderables (sounds, smells, a bell that does NOT ring) go in narrationOnly. Feature kinds are dotted concepts (building.boathouse, dock.long, prop.rowboat, decor.corpse, actor.villager) — name what a top-down map would SHOW. Always give frame.entry (where the party comes in) and position PARTY relative to the anchor feature with a near/at-edge-of constraint.

EXAMPLE (one beat, id "scene:b1"):
Beat scene:b1 — "The party arrives at a fishing village as drowned corpses surface; rowboats at a long dock, a leaning boathouse."
{"specs":{"scene:b1":{"specVersion":1,"brief":"a stilt shanty-town on a black reservoir; a long dock, a leaning boathouse, corpses surfacing","frame":{"grammar":"settlement","entry":{"edge":"west","pose":"arriving"}},"conditions":[{"profile":"fog"},{"profile":"dusk"}],"features":[{"id":"dock1","kind":"dock.long","geom":"network"},{"id":"boathouse1","kind":"building.boathouse","geom":"region","states":{"lean":"sagging"}},{"id":"rowboats","kind":"prop.rowboat","geom":"point","count":3},{"id":"corpses","kind":"decor.corpse","geom":"point","count":5},{"id":"lampPost1","kind":"prop.lamp-post","geom":"point","states":{"lit":"true"}}],"constraints":[{"c":"at-edge-of","a":"dock1","region":"water","w":"hard"},{"c":"near","a":"boathouse1","b":"dock1","w":"hard"},{"c":"along","a":"rowboats","b":"dock1","w":"story"},{"c":"in","a":"corpses","region":"water","w":"hard"},{"c":"near","a":"PARTY","b":"dock1","w":"story"}],"narrationOnly":["the deep wet toll felt in the chest"]}}}

Now write the specs JSON for ALL the beats you are given. Output ONLY the JSON.`;

export interface ArchitectBeat {
  id: string;
  title: string;
  summary: string;
  plan?: ScenePlan;
}

export interface ArchitectSpecsResult {
  /** Validated specs by beat id — invalid ones are dropped (see warnings), never stored. */
  specs: Record<string, SceneSpec>;
  warnings: string[];
  costUsd: number;
}

const extractJson = (t: string): unknown => {
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
};

/** MECHANICAL repairs before validation — deterministic fixes for conflicts an LLM repair round
 *  reliably fumbles. v1: hard `across` + hard `near` on the same pair is unsatisfiable → demote the
 *  `near` to story (the drama survives as a re-narratable degradation instead of losing the spec). */
export function mechanicalRepairs(spec: SceneSpec): string[] {
  const notes: string[] = [];
  const cons = Array.isArray(spec.constraints) ? spec.constraints : [];
  const hardAcross = new Set(
    cons.filter((c) => c?.c === 'across' && c.w === 'hard' && c.a && c.b).map((c) => [c.a, c.b].sort().join('|')),
  );
  for (const c of cons) {
    if (c?.c === 'near' && c.w === 'hard' && c.a && c.b && hardAcross.has([c.a, c.b].sort().join('|'))) {
      c.w = 'story';
      notes.push(`demoted near(${c.a},${c.b}) hard→story (conflicts with a hard across on the same pair)`);
    }
  }
  return notes;
}

/** One batched emission for a whole campaign (+ ONE batched repair round for the invalid subset). */
export async function architectSpecs(
  llm: LlmProvider,
  input: { premise: string; beats: ArchitectBeat[]; system?: string; model?: string; temperature?: number },
): Promise<ArchitectSpecsResult> {
  const system = input.system ?? DEFAULT_SCENE_ARCHITECT_SYSTEM;
  const beatLines = input.beats.map((b) => {
    const p = b.plan;
    const planLine = p ? ` | look: ${p.look} | kind: ${p.kind} | mood: ${p.mood}${p.features?.length ? ` | features: ${p.features.join(', ')}` : ''}` : '';
    return `Beat ${b.id} — "${b.title}": ${b.summary}${planLine}`;
  });
  const user = `CAMPAIGN PREMISE: ${input.premise}\n\nBEATS:\n${beatLines.join('\n\n')}`;
  const warnings: string[] = [];
  let costUsd = 0;

  const call = async (messages: { role: 'user' | 'assistant'; content: string }[]): Promise<Record<string, unknown>> => {
    const res = await llm.complete({
      system,
      messages,
      maxTokens: 4000,
      ...(input.model ? { model: input.model } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    });
    costUsd += estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens);
    const parsed = extractJson(res.text) as { specs?: Record<string, unknown> } | null;
    return parsed?.specs && typeof parsed.specs === 'object' ? (parsed.specs as Record<string, unknown>) : {};
  };

  const raw = await call([{ role: 'user', content: user }]);
  const specs: Record<string, SceneSpec> = {};
  const invalid: { id: string; violations: string[] }[] = [];
  for (const b of input.beats) {
    const cand = raw[b.id];
    if (!cand || typeof cand !== 'object') { invalid.push({ id: b.id, violations: ['missing spec for this beat'] }); continue; }
    for (const n of mechanicalRepairs(cand as SceneSpec)) warnings.push(`beat ${b.id}: ${n}`);
    const rep = validateSceneSpec(cand as SceneSpec);
    if (rep.ok) specs[b.id] = cand as SceneSpec;
    else invalid.push({ id: b.id, violations: rep.violations.map((v) => `${v.code}: ${v.message}`) });
  }

  // ONE batched repair round for whatever failed (the R2 posture; a second failure drops the spec).
  if (invalid.length) {
    const fixMsg = `These beats' specs failed validation — fix ALL the listed problems and output ONLY {"specs": {...}} for JUST these beats:\n${invalid
      .map((x) => `- ${x.id}:\n${x.violations.map((v) => `    ${v}`).join('\n')}`)
      .join('\n')}`;
    const repaired = await call([
      { role: 'user', content: user },
      { role: 'assistant', content: JSON.stringify({ specs: raw }) },
      { role: 'user', content: fixMsg },
    ]);
    for (const x of invalid) {
      const cand = repaired[x.id];
      if (cand && typeof cand === 'object') for (const n of mechanicalRepairs(cand as SceneSpec)) warnings.push(`beat ${x.id}: ${n}`);
      const rep = cand && typeof cand === 'object' ? validateSceneSpec(cand as SceneSpec) : { ok: false as const, violations: [{ code: 'missing', message: 'no repaired spec' }] };
      if (rep.ok) specs[x.id] = cand as SceneSpec;
      else warnings.push(`beat ${x.id}: spec dropped after repair (${'violations' in rep ? rep.violations.map((v) => v.message).join('; ') : 'invalid'})`);
    }
  }

  return { specs, warnings, costUsd };
}
