/**
 * Loads `.env` into process.env for local dev (no dotenv dependency). Must be
 * imported first. In containers, env vars are injected directly and the .env file
 * is absent (gitignored) — the read simply fails and we use the real environment.
 * Never overrides a variable that is already set.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath =
  process.env.MYTHWEAVER_ENV_FILE ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');

try {
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key]) continue; // don't override the real environment
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
} catch {
  /* no .env file — rely on the process environment (e.g. Docker) */
}
