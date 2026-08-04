#!/usr/bin/env node
// DEV SERVER SUPERVISOR — auto-rebuild + auto-restart on ANY workspace change, INCLUDING the compiled
// packages the server imports (packages/scene, shared, engine, rag, llm). `tsx watch src` alone reloads
// only apps/server/src and is BLIND to packages/*/dist — so a forestGen edit rebuilt but never reached a
// running server (the "did you refresh the lab?" trap). This runs two watchers:
//   1. `tsc -b --watch` — recompiles every workspace's src → dist on change (project references).
//   2. an fs.watch on the dist dirs — restarts `node apps/server/dist/index.js` whenever a dist updates.
// Net: edit any .ts anywhere → dist rebuilds → server restarts with the fresh code. The server self-loads
// .env (import './env.js'), so no env plumbing here. Ctrl-C stops everything.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (n) => join(ROOT, 'node_modules', '.bin', n);
const log = (m) => process.stdout.write(`\x1b[36m[dev]\x1b[0m ${m}\n`);

// 1. incremental compiler across the whole project graph.
const tsc = spawn(bin('tsc'), ['-b', '--watch', '--preserveWatchOutput'], { stdio: 'inherit', cwd: ROOT });

// 2. the server child, restarted when a watched dist changes.
let server = null;
let restartTimer = null;
let starting = false;

function startServer() {
  starting = false;
  server = spawn('node', ['apps/server/dist/index.js'], { stdio: 'inherit', cwd: ROOT, env: process.env });
  server.on('exit', (code, sig) => {
    server = null;
    if (!starting && code !== null && sig === null && code !== 0) log(`server exited (code ${code}) — waiting for the next change to retry…`);
  });
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  // debounce: tsc writes many files (.js + .d.ts + .tsbuildinfo) per rebuild; coalesce into one restart.
  restartTimer = setTimeout(() => {
    starting = true;
    if (server) { server.once('exit', startServer); server.kill('SIGTERM'); }
    else startServer();
    log('dist changed → restarting server…');
  }, 350);
}

// Watch the compiled outputs the server depends on. (Watching dist, not src, means we only restart AFTER
// a successful emit — a file with a type error leaves dist untouched, so the last-good server keeps running.)
const DIST_DIRS = ['apps/server/dist', 'packages/scene/dist', 'packages/shared/dist', 'packages/engine/dist', 'packages/rag/dist', 'packages/llm/dist'];
for (const d of DIST_DIRS) {
  try { watch(join(ROOT, d), { recursive: true }, (_e, f) => { if (!f || f.endsWith('.js')) scheduleRestart(); }); }
  catch { /* dir not built yet — tsc will create it, the parent watch below still catches the app */ }
}

log('starting (tsc -b --watch + server; edits to any package hot-restart the server)');
startServer();

const shutdown = () => { try { tsc.kill('SIGTERM'); } catch {} try { server?.kill('SIGTERM'); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
