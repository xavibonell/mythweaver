// Ingest real-session transcripts into the STYLE-EXEMPLAR corpus (Technique B).
// Parse -> exchange windows -> heuristic moveType tagging -> deterministic sampling
//   -> (paid) LLM curation: keep/drop + anonymize-by-rewrite + strip mechanical verdicts
//   -> write content/exemplars/<set>.jsonl (+ .vectors.jsonl via the embeddings provider).
//
// Run: npm run build && node scripts/ingest-exemplars.mjs [--dry-run] [--limit N] [--set cr3] [dir]
//   --dry-run  $0: stop after sampling; write <set>.candidates.jsonl + print per-type counts.
//   --limit N  curate only the first N sampled candidates (cheap trial run).
// Reads .env for ANTHROPIC_API_KEY (curation) + OPENAI_API_KEY/VOYAGE_API_KEY (embeddings).
// Output lives under content/ (gitignored) — transcripts and derivatives never leave the machine.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTranscript, buildCandidates, sampleCandidates, CURATE_SYSTEM } from '../apps/server/dist/exemplar-ingest.js';
import { createProvider, estimateCostUsd } from '../packages/llm/dist/index.js';
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from '../packages/rag/dist/index.js';

try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const setIdx = args.indexOf('--set');
const setName = setIdx >= 0 ? args[setIdx + 1] : 'cr3';
const dir = args.filter((a, i) => !a.startsWith('--') && (limitIdx < 0 || i !== limitIdx + 1) && (setIdx < 0 || i !== setIdx + 1))[0] ?? 'raw-data/transcripts';
const outDir = resolve('content/exemplars');
mkdirSync(outDir, { recursive: true });

// 1-2. Parse + window + tag ($0, deterministic).
const files = readdirSync(resolve(dir)).filter((f) => f.endsWith('.txt'));
let all = [];
for (const f of files) {
  // Robust source label: campaign + episode when present, else a filename slug (never a blind 12-char cut).
  const epMatch = f.match(/Episode_(\d+)/i);
  const campMatch = f.match(/Campaign_(\d+)/i);
  const camp = campMatch ? campMatch[1] : '3';
  const source = epMatch ? `CR${camp} E${epMatch[1]}` : `CR${camp} ${f.replace(/\.txt$/i, '').replace(/_/g, ' ').slice(0, 40)}`;
  const turns = parseTranscript(readFileSync(join(resolve(dir), f), 'utf8'));
  // SET-PREFIX the id so two sets never collide in the merged vectors Map (loadExemplars globs every
  // *.jsonl and keys vectors by id — a cross-set collision would silently serve one vector to two rows).
  all = all.concat(buildCandidates(turns, source).map((c) => ({ ...c, id: `${setName}:${c.id}` })));
}
// Guard: ids must be unique within this set (a dup would corrupt the vectors Map exactly like a cross-set one).
const seenIds = new Set();
for (const c of all) {
  if (seenIds.has(c.id)) throw new Error(`duplicate candidate id ${c.id} — id scheme is not unique`);
  seenIds.add(c.id);
}
const sampled = sampleCandidates(all);
const counts = {};
for (const c of sampled) counts[c.moveType] = (counts[c.moveType] ?? 0) + 1;
console.log(`parsed ${files.length} transcripts -> ${all.length} clean DM beats -> sampled ${sampled.length}`);
console.log('per moveType:', counts);

if (dryRun) {
  const p = join(outDir, `${setName}.candidates.jsonl`);
  writeFileSync(p, sampled.map((c) => JSON.stringify(c)).join('\n') + '\n');
  console.log(`--dry-run: wrote ${p} ($0, no LLM/embeddings). Inspect, then rerun without --dry-run.`);
  process.exit(0);
}

// 3. Paid curation pass (batched). Provider is configurable so the ingest can run on whichever account
//    has balance — MYTHWEAVER_INGEST_PROVIDER=openai uses the OpenAI key instead of Anthropic.
const ingestProvider = (process.env.MYTHWEAVER_INGEST_PROVIDER || 'anthropic').toLowerCase();
const ingestModel = process.env.MYTHWEAVER_INGEST_MODEL || (ingestProvider === 'anthropic' ? 'claude-haiku-4-5-20251001' : undefined);
const llm = createProvider(ingestProvider, ingestModel ? { model: ingestModel } : {});
console.log(`curating with ${ingestProvider}${ingestModel ? ` (${ingestModel})` : ' (default model)'}`);
const toCurate = sampled.slice(0, limit);
const BATCH = 12;
const CONCURRENCY = 6;
// Curators sometimes decorate the moveType ("confirm — short-answer"); pin it to a canonical value
// (recover an embedded type, else fall back to the deterministic heuristic tag on the candidate).
const CANON_MOVES = ['general', 'npc-voice', 'short-answer', 'roll-call', 'combat-beat', 'scene-set', 'roll-verdict'];
const canonMove = (mt, fallback) => {
  if (CANON_MOVES.includes(mt)) return mt;
  if (typeof mt === 'string') { for (const c of CANON_MOVES) if (mt.includes(c)) return c; }
  return fallback;
};
const kept = [];
let cost = 0;
let done = 0;
const batches = [];
for (let i = 0; i < toCurate.length; i += BATCH) batches.push(toCurate.slice(i, i + BATCH));

async function curateBatch(batch) {
  const payload = batch.map((c, i) => ({ i, moveType: c.moveType, cue: c.cue, text: c.text }));
  try {
    const res = await llm.complete({
      system: CURATE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      maxTokens: 4000,
    });
    cost += estimateCostUsd(res.model, res.usage.inputTokens, res.usage.outputTokens);
    const jsonStart = res.text.indexOf('[');
    const jsonEnd = res.text.lastIndexOf(']');
    if (jsonStart < 0 || jsonEnd < 0) return;
    const rows = JSON.parse(res.text.slice(jsonStart, jsonEnd + 1));
    for (const r of rows) {
      const src = batch[r.i];
      if (!src || r.keep !== true || typeof r.text !== 'string' || r.text.length < 40) continue;
      kept.push({ id: src.id, source: src.source, moveType: canonMove(r.moveType, src.moveType), tone: r.tone ?? '', cue: String(r.cue ?? '').slice(0, 200), text: r.text.slice(0, 1200) });
    }
  } catch (e) {
    console.warn(`  batch failed (skipped): ${e.message}`);
  } finally {
    done++;
    process.stdout.write(`\r  curated ${done}/${batches.length} batches, kept ${kept.length}, ~$${cost.toFixed(2)}`);
  }
}

console.log(`curating ${toCurate.length} candidates in ${batches.length} batches…`);
for (let i = 0; i < batches.length; i += CONCURRENCY) {
  await Promise.all(batches.slice(i, i + CONCURRENCY).map(curateBatch));
}
console.log('');

// Abort loudly rather than overwrite a good corpus with nothing — e.g. every batch 400'd on billing.
if (kept.length === 0) {
  console.error(`\n✗ curation kept 0 exemplars (every batch failed — check the API key / credit balance above).\n  NOT writing an empty ${setName}.jsonl. Candidates are cached at ${join(outDir, `${setName}.candidates.jsonl`)}; fix the key and re-run.`);
  process.exit(1);
}

const jsonlPath = join(outDir, `${setName}.jsonl`);
writeFileSync(jsonlPath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${jsonlPath} (${kept.length} exemplars, curation ~$${cost.toFixed(2)})`);

// 4. Embed cue+text -> <set>.vectors.jsonl (same on-disk shape as the rules corpus).
if (!process.env.OPENAI_API_KEY && !process.env.VOYAGE_API_KEY) {
  console.log('no embeddings key — skipped vectors (retriever will fall back to BM25). Run embed later.');
  process.exit(0);
}
const provider = process.env.OPENAI_API_KEY ? new OpenAIEmbeddingProvider() : new VoyageEmbeddingProvider();
console.log(`embedding with ${provider.model} (dim ${provider.dimension})…`);
const EMBATCH = 256;
const vecLines = [];
for (let i = 0; i < kept.length; i += EMBATCH) {
  const batch = kept.slice(i, i + EMBATCH);
  const vecs = await provider.embed(batch.map((r) => `${r.cue}\n${r.text}`));
  for (let j = 0; j < batch.length; j++) {
    vecLines.push(JSON.stringify({ id: batch[j].id, v: Buffer.from(Float32Array.from(vecs[j]).buffer).toString('base64') }));
  }
  process.stdout.write(`\r  ${Math.min(i + EMBATCH, kept.length)}/${kept.length}`);
}
const vecPath = join(outDir, `${setName}.vectors.jsonl`);
writeFileSync(vecPath, vecLines.join('\n') + '\n');
console.log(`\nwrote ${vecPath} (${vecLines.length} vectors)`);
