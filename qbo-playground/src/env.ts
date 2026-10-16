import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Repo-root .env (gitignored): configuration only, never written by code.
export const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));

export function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

export function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key} in ${ENV_PATH}`);
  return value;
}
