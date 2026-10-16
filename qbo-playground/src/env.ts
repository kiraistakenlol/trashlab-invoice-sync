import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Repo-root .env (gitignored). Read on demand; tokens are written back here.
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

// Updates or appends keys, leaving the rest of the file as is.
export function writeEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').replace(/\n+$/, '').split('\n') : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const key = line.slice(0, line.indexOf('=')).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, out.join('\n') + '\n');
}

export function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key} in ${ENV_PATH}`);
  return value;
}
