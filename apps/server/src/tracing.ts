/**
 * Tracing seam (observability). The orchestrator emits a trace per turn — the LLM
 * generation(s), tool calls, and the final outcome — through this interface, so the
 * backend is swappable:
 *   - JsonlTracer  : appends one JSON line per turn to a local file (default; no deps/keys)
 *   - LangfuseTracer: ships to Langfuse cloud/self-host (activated by LANGFUSE_* env)
 *   - NoopTracer   : disabled
 *
 * The Langfuse client is imported lazily and every call is guarded, so a missing
 * package or an SDK API change can never break a turn.
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GenerationLog {
  name: string;
  model: string;
  input: unknown;
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TurnEndLog {
  narration: string;
  costUsd: number;
  model: string;
  latencyMs: number;
  toolCalls: string[];
}

export interface TurnTrace {
  readonly id: string;
  generation(g: GenerationLog): void;
  event(name: string, data?: Record<string, unknown>): void;
  end(log: TurnEndLog): void;
  score(name: string, value: number, comment?: string): void;
}

export interface Tracer {
  startTurn(meta: { sessionId: string; speaker?: string; input: string }): TurnTrace;
  flush(): Promise<void>;
}

// --- Noop -----------------------------------------------------------------

const NOOP_TURN: TurnTrace = {
  id: '',
  generation() {},
  event() {},
  end() {},
  score() {},
};

export class NoopTracer implements Tracer {
  startTurn(): TurnTrace {
    return NOOP_TURN;
  }
  async flush(): Promise<void> {}
}

// --- JSONL (local file; default) ------------------------------------------

class JsonlTurnTrace implements TurnTrace {
  readonly id = randomUUID();
  private readonly generations: GenerationLog[] = [];
  private readonly events: { name: string; data?: Record<string, unknown> }[] = [];
  private readonly scores: { name: string; value: number; comment?: string }[] = [];

  constructor(private readonly file: string, private readonly meta: Record<string, unknown>) {}

  generation(g: GenerationLog): void {
    this.generations.push(g);
  }
  event(name: string, data?: Record<string, unknown>): void {
    this.events.push({ name, ...(data ? { data } : {}) });
  }
  score(name: string, value: number, comment?: string): void {
    this.scores.push({ name, value, ...(comment ? { comment } : {}) });
  }
  end(log: TurnEndLog): void {
    const rec = {
      id: this.id,
      ts: new Date().toISOString(),
      ...this.meta,
      ...log,
      generations: this.generations,
      events: this.events,
      scores: this.scores,
    };
    try {
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
    } catch {
      /* ignore trace write failures */
    }
  }
}

export class JsonlTracer implements Tracer {
  constructor(private readonly file: string) {}
  startTurn(meta: { sessionId: string; speaker?: string; input: string }): TurnTrace {
    return new JsonlTurnTrace(this.file, meta);
  }
  async flush(): Promise<void> {}
}

// --- Langfuse (lazy, fully guarded) ---------------------------------------

export class LangfuseTracer implements Tracer {
  constructor(private readonly client: { trace: (a: unknown) => unknown; score: (a: unknown) => unknown; flushAsync?: () => Promise<unknown> }) {}

  startTurn(meta: { sessionId: string; speaker?: string; input: string }): TurnTrace {
    let trace: any;
    try {
      trace = (this.client as any).trace({ name: 'dm-turn', sessionId: meta.sessionId, input: meta.input, metadata: { speaker: meta.speaker } });
    } catch {
      /* ignore */
    }
    const client = this.client as any;
    return {
      id: trace?.id ?? '',
      generation(g) {
        try {
          trace?.generation({
            name: g.name,
            model: g.model,
            input: g.input,
            output: g.output,
            usage: { input: g.inputTokens, output: g.outputTokens, unit: 'TOKENS' },
            metadata: { costUsd: g.costUsd },
          });
        } catch {
          /* ignore */
        }
      },
      event(name, data) {
        try {
          trace?.event({ name, metadata: data });
        } catch {
          /* ignore */
        }
      },
      end(log) {
        try {
          trace?.update({
            output: log.narration,
            metadata: { costUsd: log.costUsd, model: log.model, latencyMs: log.latencyMs, toolCalls: log.toolCalls },
          });
        } catch {
          /* ignore */
        }
      },
      score(name, value, comment) {
        try {
          if (trace?.id) client.score({ traceId: trace.id, name, value, ...(comment ? { comment } : {}) });
        } catch {
          /* ignore */
        }
      },
    };
  }

  async flush(): Promise<void> {
    try {
      await (this.client as any).flushAsync?.();
    } catch {
      /* ignore */
    }
  }
}

// --- Selection ------------------------------------------------------------

export async function buildTracer(): Promise<{ tracer: Tracer; description: string }> {
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  if (pk && sk) {
    try {
      const mod: any = await import('langfuse');
      const Langfuse = mod.Langfuse ?? mod.default;
      const baseUrl = process.env.LANGFUSE_BASEURL || process.env.LANGFUSE_HOST || undefined;
      const client = new Langfuse({ publicKey: pk, secretKey: sk, baseUrl });
      return { tracer: new LangfuseTracer(client), description: `langfuse (${baseUrl ?? 'cloud'})` };
    } catch (err) {
      // Package missing or SDK mismatch — fall back to local JSONL rather than failing.
      // eslint-disable-next-line no-console
      console.warn('Langfuse keys set but client init failed; using JSONL traces instead:', (err as Error).message);
    }
  }
  const file =
    process.env.MYTHWEAVER_TRACE_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../traces.jsonl');
  return { tracer: new JsonlTracer(file), description: `jsonl (${file})` };
}
