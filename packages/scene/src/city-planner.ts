/**
 * City planner (city-scope V3) — the MACRO tier of two-tier city generation. ONE LLM call turns a
 * freeform city brief into a roster of district specs; the deterministic V2 stitcher (buildCityScene)
 * then assembles them. So a whole city costs ~ONE cheap call (NOT one per district) — the per-district
 * art + layout stays the proven $0 path. The model only chooses the QUARTERS and their flavour.
 *
 * Robust-by-construction (mirrors composer.ts's buildComposition): the model's JSON is UNTRUSTED;
 * normalizeDistricts clamps district count, whitelists building tags to ones the Cartographer can
 * carve, strips water words from settings (the renderer has no city water; a per-district pond reads
 * wrong), guarantees each setting reads as a settlement, and yields a usable roster even from garbage.
 */

import type { LlmProvider } from '@mythweaver/llm';
import type { CityDistrictSpec } from './city.js';

export const CITY_PLANNER_SYSTEM = `You are the CITY PLANNER for a top-down pixel-art fantasy RPG. Given a player's description of a city or town, design its DISTRICTS (quarters). Output ONLY JSON, no prose:
{"districts":[{"setting":"<short phrase>","builds":["tavern","smithy"],"npcs":[{"name":"Borin","look":"a dwarf smith"}]}]}

RULES:
- Design 4-8 DISTINCT districts, each a recognizable quarter (market, temple/holy, residential, craftsmen, barracks/garrison, noble, slums, scholars, ...). Match the player's THEME: a grim mining town leans craft + slums + barracks; a holy city leans temples + pilgrim lodging + market.
- "builds": 2-4 BUILDINGS per district, ONLY from these words (the engine carves each as a walled, furnished room): house, cottage, manor, hall, tavern, inn, shop, store, apothecary, bakery, guildhall, temple, shrine, chapel, smithy, forge, workshop, mill, tower, barn. Pick ones that fit the quarter (temple quarter -> temple, shrine, house; craft quarter -> smithy, workshop, shop).
- "npcs": 1-2 inhabitants per district. "look" is a short description the engine maps to a sprite (a guard, a robed priest, a merchant woman, a hooded ranger, a dwarf smith, a villager). "name" is a short name or role.
- "setting": a SHORT evocative phrase for the quarter (e.g. "a bustling market square", "a quiet temple precinct"). Do NOT mention water, rivers, docks, the sea, canals, harbours or shores — the renderer has no city water yet; render a port as warehouses + market instead.
Keep it coherent: a believable city of distinct, lived-in quarters.`;

/** Building words the Cartographer's classifier (buildingTypeOf) actually carves into rooms. Anything
 *  the model invents outside this set is mapped to 'house' so a district never silently loses a plot. */
const KNOWN_BUILDS = new Set([
  'house', 'cottage', 'cabin', 'hut', 'manor', 'hall', 'farmhouse', 'longhouse', 'mill', 'tower', 'barn',
  'shop', 'store', 'emporium', 'apothecary', 'bakery', 'butcher', 'tailor', 'guildhall',
  'tavern', 'inn', 'alehouse', 'lodge',
  'temple', 'shrine', 'chapel', 'cathedral', 'sanctuary', 'abbey', 'church',
  'smithy', 'forge', 'foundry', 'workshop', 'blacksmith',
]);

const WATER_RE = /\b(seas?|coast(?:al|line)?|fens?|marsh(?:es|land)?|bogs?|swamps?|waters?|lakes?|rivers?|docks?|piers?|harbou?rs?|shores?|bays?|canals?|wharf|waterfront|riverside|quay)\b/gi;

function mapBuild(b: string): string {
  const w = b.toLowerCase().trim().replace(/[^a-z]/g, '');
  if (KNOWN_BUILDS.has(w)) return w;
  if (w.endsWith('s') && KNOWN_BUILDS.has(w.slice(0, -1))) return w; // keep plural ("cottages" -> several rooms)
  return 'house';
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Turn the model's (untrusted) JSON into a guaranteed-usable CityDistrictSpec[]. */
export function normalizeDistricts(raw: unknown, max = 9): CityDistrictSpec[] {
  const r = asRecord(raw);
  const arr = Array.isArray(r.districts) ? r.districts : [];
  const out: CityDistrictSpec[] = [];
  for (const item of arr) {
    if (out.length >= max) break;
    const d = asRecord(item);
    let builds = (Array.isArray(d.builds) ? d.builds : []).filter((b): b is string => typeof b === 'string').map(mapBuild).slice(0, 4);
    if (!builds.length) builds = ['house', 'house'];
    const npcs = (Array.isArray(d.npcs) ? d.npcs : [])
      .map(asRecord)
      .filter((n) => typeof n.look === 'string' && (n.look as string).trim())
      .slice(0, 2)
      .map((n) => ({ name: typeof n.name === 'string' && n.name.trim() ? (n.name as string).slice(0, 40) : 'a townsfolk', look: (n.look as string).slice(0, 60) }));
    const base = typeof d.setting === 'string' ? (d.setting as string).replace(WATER_RE, '').replace(/\s{2,}/g, ' ').trim() : '';
    // Append the builds so the setting ALWAYS contains a settlement keyword (sceneKindOf needs one to
    // pick the town-square grammar) and reads coherently — e.g. "a quiet temple precinct with temple, shrine".
    const setting = `${base || 'a city quarter'} with ${builds.join(', ')}`;
    out.push({ setting, builds, npcs });
  }
  if (!out.length) out.push({ setting: 'a market square with tavern, shop, house', builds: ['tavern', 'shop', 'house'], npcs: [] });
  return out;
}

/** The macro tier: one LLM call → a robust roster of district specs for buildCityScene. */
export class LlmCityPlanner {
  constructor(private readonly llm: LlmProvider, private readonly model?: string) {}

  async plan(brief: string, opts: { max?: number } = {}): Promise<CityDistrictSpec[]> {
    const res = await this.llm.complete({
      system: CITY_PLANNER_SYSTEM,
      messages: [{ role: 'user', content: brief }],
      maxTokens: 1300,
      ...(this.model ? { model: this.model } : {}),
    });
    let raw: unknown = {};
    try {
      const m = res.text.match(/\{[\s\S]*\}/);
      if (m) raw = JSON.parse(m[0]);
    } catch {
      raw = {}; // garbage → normalizeDistricts falls back to a usable default
    }
    return normalizeDistricts(raw, opts.max ?? 9);
  }
}
