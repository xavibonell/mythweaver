-- MythWeaver schema (spec §7 persistence, §5 RAG). Loaded by the pgvector image on first boot.

CREATE EXTENSION IF NOT EXISTS vector;

-- Sessions: authoritative GameState as JSONB (save/resume, spec §7 v1 slice).
CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY,
  scenario_id  text NOT NULL,
  state        jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Transcript / audit log (spec §13). The canonical world-state lives inside
-- sessions.state.flags for v1; the episodic vector tier is added in a later phase.
CREATE TABLE IF NOT EXISTS messages (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  speaker     text,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id);

-- RAG corpus (wired in P1, build plan P1-3). The vector dimension is a HARD
-- invariant that must equal the embedding model's output dim — voyage-3-large =
-- 1024. Changing the vendor/dimension requires a re-embed + migration (spec §5.2).
-- `namespace` keeps shared SRD/lore separate from any future per-user content (spec §11).
CREATE TABLE IF NOT EXISTS rag_chunks (
  id         text PRIMARY KEY,
  namespace  text NOT NULL DEFAULT 'srd',
  source     text NOT NULL,
  content    text NOT NULL,
  embedding  vector(1024)
);
CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
  ON rag_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS rag_chunks_namespace_idx ON rag_chunks (namespace);
