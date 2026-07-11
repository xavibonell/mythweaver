/**
 * Eval runner (spec §10): runs each case through the REAL brain, judges the
 * narration, AND runs deterministic tool-use assertions (component 1). The script
 * (scripts/eval.mjs) handles the baseline file + regression gate. Makes real API
 * calls — costs money.
 */

import { Engine, createInitialState } from '@mythweaver/engine';
import { createProvider, type LlmProvider } from '@mythweaver/llm';
import { FakeSceneComposer } from '@mythweaver/scene';
import { loadScenario } from '../content.js';
import { buildRetriever } from '../corpus.js';
import { buildExemplarRetriever } from '../exemplar-corpus.js';
import { autoRollTotal } from '../dm-lab.js';
import { loadPlaybook } from '../prompts.js';
import { runTurn, type TurnResult } from '../orchestrator.js';
import { EVAL_CASES, type EvalCase, type ToolExpectation } from './cases.js';
import { judgeNarration, RUBRIC_DIMENSIONS, type Scores } from './rubric.js';

export interface AssertionResult {
  ok: boolean;
  failures: string[];
}

export interface CaseResult {
  id: string;
  scores: Scores;
  narration: string;
  /** Every tool the case called, accumulated across all its turns (incl. roll resumes). */
  toolCalls: string[];
  /** Deterministic rules-correctness check (spec §10 component 1). */
  assertions: AssertionResult;
}

export interface EvalReport {
  perCase: CaseResult[];
  means: Scores;
  runs: number;
  /** "<caseId>: <reason>" for every failed tool-use assertion across the report. */
  assertionFailures: string[];
}

/** Deterministic tool-use check — independent of the fuzzy LLM judge. */
export function checkToolExpectation(exp: ToolExpectation | undefined, calls: string[]): AssertionResult {
  const failures: string[] = [];
  const used = new Set(calls);
  for (const r of exp?.required ?? []) if (!used.has(r)) failures.push(`missing required tool "${r}" (used: ${calls.join(', ') || 'none'})`);
  for (const f of exp?.forbidden ?? []) if (used.has(f)) failures.push(`used forbidden tool "${f}"`);
  return { ok: failures.length === 0, failures };
}

async function runCase(
  c: EvalCase,
  llm: LlmProvider,
  retriever: ReturnType<typeof buildRetriever>['retriever'],
  exemplars?: ReturnType<typeof buildExemplarRetriever>['exemplars'],
): Promise<CaseResult> {
  const bundle = loadScenario(c.scenario);
  const adventure = {
    pitch: bundle.scenario.pitch,
    scenes: Object.fromEntries(bundle.scenario.scenes.map((s) => [s.id, { title: s.title, summary: s.summary, exits: s.exits }])),
  };
  const state = createInitialState({
    sessionId: `eval-${c.id}`,
    scenarioId: bundle.scenario.id,
    startSceneId: bundle.scenario.startSceneId,
    party: bundle.pregens,
    adventure,
    encounters: bundle.scenario.encounters,
    bestiary: Object.fromEntries(bundle.bestiary.map((b) => [b.id, b])),
  });
  const engine = new Engine(state);
  const composer = new FakeSceneComposer(); // parity with prod: the DM gets the setScene tool
  const playbook = loadPlaybook(); // parity with prod: judge the EDITED persona, not the default fallback

  const recent: string[] = [];
  const allToolCalls: string[] = [];
  let last: TurnResult | undefined;
  let lastMessageText = '';

  let i = 0;
  while (i < c.turns.length) {
    const entry = c.turns[i]!;
    if ('roll' in entry) {
      i++; // a stray roll with no pending request — skip
      continue;
    }
    lastMessageText = entry.text;
    // eslint-disable-next-line no-await-in-loop
    last = await runTurn(
      { engine, llm, retriever, composer, playbook, recentTranscript: recent, ...(exemplars ? { exemplars } : {}) },
      { kind: 'message', speakerId: entry.speakerId, text: entry.text },
    );
    allToolCalls.push(...last.trace.toolCalls);
    recent.push(`${entry.speakerId}: ${entry.text}`, `Dungeon Master: ${last.narration}`);
    i++;

    // Resolve any chain of roll requests (consume scripted rolls, else auto-roll a plausible total).
    while (last.rollRequest) {
      const next = c.turns[i];
      let total: number;
      if (next && 'roll' in next) {
        total = next.roll;
        i++;
      } else {
        total = autoRollTotal(last.rollRequest.expr);
      }
      const reqId = last.rollRequest.id;
      // eslint-disable-next-line no-await-in-loop
      last = await runTurn({ engine, llm, retriever, composer, playbook, recentTranscript: recent, ...(exemplars ? { exemplars } : {}) }, { kind: 'roll', requestId: reqId, total });
      allToolCalls.push(...last.trace.toolCalls);
      recent.push(`roll: 🎲 ${total}`, `Dungeon Master: ${last.narration}`);
    }
  }
  if (!last) throw new Error(`Eval case ${c.id} produced no turn`);

  // Judge with a model that matches the configured provider (override with MYTHWEAVER_JUDGE_MODEL).
  const judgeModel = process.env.MYTHWEAVER_JUDGE_MODEL || process.env.MYTHWEAVER_DM_MODEL || 'gpt-4o';
  const scores = await judgeNarration(llm, {
    playerInput: lastMessageText,
    narration: last.narration,
    toolCalls: allToolCalls, // the full sequence, so the judge sees rolls requested on earlier steps
    sceneSummary: adventure.scenes[state.currentSceneId]?.summary,
  }, judgeModel);
  return { id: c.id, scores, narration: last.narration, toolCalls: allToolCalls, assertions: checkToolExpectation(c.expectTools, allToolCalls) };
}

export async function runEvals(opts: { runs?: number } = {}): Promise<EvalReport> {
  const runs = Math.max(1, opts.runs ?? 1);
  // Follow the configured provider (default openai — no Anthropic budget). The turn DM and the judge
  // both run on it; MYTHWEAVER_JUDGE_MODEL can override just the judge.
  const llm = createProvider(process.env.MYTHWEAVER_DM_PROVIDER || 'openai', process.env.MYTHWEAVER_DM_MODEL ? { model: process.env.MYTHWEAVER_DM_MODEL } : {});
  const { retriever } = buildRetriever(null); // vector/keyword retrieval needs no DB
  const { exemplars, description: exemplarMode } = buildExemplarRetriever(); // A/B via MYTHWEAVER_EXEMPLARS=off
  console.log(`style exemplars: ${exemplarMode}`);

  const perCase: CaseResult[] = [];
  for (let r = 0; r < runs; r++) {
    for (const c of EVAL_CASES) {
      // eslint-disable-next-line no-await-in-loop
      perCase.push(await runCase(c, llm, retriever, exemplars));
    }
  }

  const means = {} as Scores;
  for (const d of RUBRIC_DIMENSIONS) {
    means[d.key] = perCase.reduce((sum, x) => sum + x.scores[d.key], 0) / perCase.length;
  }
  const assertionFailures = perCase.flatMap((x) => x.assertions.failures.map((f) => `${x.id}: ${f}`));
  return { perCase, means, runs, assertionFailures };
}
