/** Postgres persistence (spec §7 v1 slice: save/resume). Schema in db/init/001_init.sql. */

import pg from 'pg';
import type { GameState } from '@mythweaver/shared';

const { Pool } = pg;

export interface SessionRow {
  id: string;
  scenarioId: string;
  state: GameState;
}

export class Db {
  private readonly pool: InstanceType<typeof Pool>;

  constructor(connectionString: string | undefined = process.env.DATABASE_URL) {
    this.pool = new Pool(connectionString ? { connectionString } : {});
  }

  async createSession(id: string, scenarioId: string, state: GameState): Promise<void> {
    await this.pool.query('INSERT INTO sessions (id, scenario_id, state) VALUES ($1, $2, $3)', [id, scenarioId, state]);
  }

  async saveState(id: string, state: GameState): Promise<void> {
    await this.pool.query('UPDATE sessions SET state = $2, updated_at = now() WHERE id = $1', [id, state]);
  }

  async loadSession(id: string): Promise<SessionRow | null> {
    const r = await this.pool.query('SELECT id, scenario_id, state FROM sessions WHERE id = $1', [id]);
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.id, scenarioId: row.scenario_id, state: row.state };
  }

  async appendMessage(sessionId: string, kind: string, speaker: string, text: string): Promise<void> {
    await this.pool.query('INSERT INTO messages (session_id, kind, speaker, text) VALUES ($1, $2, $3, $4)', [sessionId, kind, speaker, text]);
  }

  /** Recent transcript lines (oldest-first) for context assembly — the canonical
   *  transcript lives here, not in the GameState blob (spec §7). */
  async recentMessages(sessionId: string, limit: number): Promise<string[]> {
    const r = await this.pool.query(
      'SELECT speaker, text FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2',
      [sessionId, limit],
    );
    return r.rows.reverse().map((row) => `${row.speaker ?? '?'}: ${row.text}`);
  }

  // --- RAG (pgvector) path: used only when MYTHWEAVER_RAG=pgvector (spec §5) ---

  async upsertChunk(chunk: { id: string; namespace: string; source: string; content: string; embedding: number[] }): Promise<void> {
    const vec = `[${chunk.embedding.join(',')}]`;
    await this.pool.query(
      `INSERT INTO rag_chunks (id, namespace, source, content, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (id) DO UPDATE SET namespace = $2, source = $3, content = $4, embedding = $5::vector`,
      [chunk.id, chunk.namespace, chunk.source, chunk.content, vec],
    );
  }

  async searchChunks(embedding: number[], namespace: string, limit: number): Promise<{ id: string; text: string; source: string; score: number }[]> {
    const vec = `[${embedding.join(',')}]`;
    const r = await this.pool.query(
      `SELECT id, source, content, 1 - (embedding <=> $1::vector) AS score
       FROM rag_chunks
       WHERE namespace = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vec, namespace, limit],
    );
    return r.rows.map((row) => ({ id: row.id, text: row.content, source: row.source, score: Number(row.score) }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
