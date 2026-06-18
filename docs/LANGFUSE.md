# Local Langfuse (self-hosted)

Observability dashboard for the DM turn-loop — fully dockerized, runs alongside the app.

## Start

```bash
npm run langfuse:up        # docker compose -f infra/langfuse/docker-compose.yml up -d
```

First run pulls several images (Postgres, ClickHouse, Redis, MinIO, Langfuse web+worker) and runs
migrations — give it ~1–2 minutes to become healthy.

- **UI:** http://localhost:3001 — log in with `admin@mythweaver.local` / `mythweaver-admin`
- The compose **headless-init** auto-creates the org/project **and the API keys the app uses**, so
  there's no UI setup step.

## How it connects to the app

`.env` is already wired to the init keys:

```
LANGFUSE_BASEURL=http://localhost:3001
LANGFUSE_PUBLIC_KEY=pk-lf-00000000-0000-4000-8000-000000000001
LANGFUSE_SECRET_KEY=sk-lf-00000000-0000-4000-8000-000000000001
```

Restart the app server (`npm run dev:server`) after Langfuse is healthy, play a turn, then open the
UI → **Traces**. Each turn is one trace with the LLM generation(s), tool calls, latency, and cost.

**If Langfuse is down or keys are unset, the app falls back to local JSONL** (`traces.jsonl`) — the
tracer is fully guarded, so a missing dashboard never breaks a turn.

## Stop / reset

```bash
npm run langfuse:down                                              # stop
docker compose -f infra/langfuse/docker-compose.yml down -v       # stop + wipe data
```

## Ports & secrets

Web `3001`, langfuse-postgres `5433`, clickhouse `8123/9000`, redis `6379`, minio `9090/9091`
(shifted so they don't clash with the app's web `3000` / pgvector `5432`). All secrets in the compose
are **local-dev defaults marked `# CHANGEME`** — change them before exposing this anywhere.

## Fully-dockerized note

When the app server itself runs inside Docker (not on the host), point it at Langfuse via a shared
network or `host.docker.internal:3001` instead of `localhost:3001`.
