// DM Lab CLI — drive the real DM brain through a scripted session and print a
// full per-turn trace (narration, tool calls + inputs + results, state diffs,
// cost/latency). The DM-side analogue of the Scene Lab. Makes real API calls.
//
//   npm run build && npm run dm:lab                      # built-in "default" transcript
//   npm run build && npm run dm:lab -- --transcript edges
//   npm run build && npm run dm:lab -- --script my-turns.json   # [{ "as":"Aldric","say":"..." }, { "roll":15 }]
//   npm run build && npm run dm:lab -- --json            # structured JSON instead of the report
//
// A custom --script is a JSON array of turns: { "say": "...", "as": "Name" } or { "roll": 12 }.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (mirrors scripts/eval.mjs).
try {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env */
}

const { runDmLab, formatDmLab, buildDmLabDeps, DM_LAB_TRANSCRIPTS } = await import('../apps/server/dist/dm-lab.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const asJson = process.argv.includes('--json');
const scenario = arg('scenario', 'the-sunken-bell');
const scriptFile = arg('script', null);
const transcriptName = arg('transcript', 'default');

let script;
if (scriptFile) {
  script = JSON.parse(readFileSync(resolve(scriptFile), 'utf8'));
} else {
  script = DM_LAB_TRANSCRIPTS[transcriptName];
  if (!script) {
    console.error(`Unknown transcript "${transcriptName}". Available: ${Object.keys(DM_LAB_TRANSCRIPTS).join(', ')}`);
    process.exit(1);
  }
}

const deps = buildDmLabDeps();
const playerTurns = script.filter((t) => 'say' in t).length;
if (!asJson) {
  console.error(`RAG: ${deps.ragMode}`);
  console.error(`Running ${playerTurns} player turn(s) through the real DM — real API calls…\n`);
}

const result = await runDmLab(deps, scenario, script);
console.log(asJson ? JSON.stringify(result, null, 2) : formatDmLab(result));
