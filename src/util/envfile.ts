/**
 * Where does .env (and credentials.json) live? Loom supports three locations
 * so the same build works as a repo clone, a global npm install, and a
 * container:
 *
 *   1. LOOM_ENV=/path/to/.env  — explicit override, always wins (.env only)
 *   2. ~/.config/loom/         — XDG config dir, preferred for global installs
 *      (respects XDG_CONFIG_HOME)
 *   3. <package root>/         — next to package.json: repo clones and the
 *      container's /app/.env mount
 *
 * Reads merge every file that exists, earlier locations winning per variable.
 * Writes go to the first location that already exists; when none does, to
 * LOOM_ENV if set, else the XDG path (directory created 0700) — never into a
 * global node_modules, where an upgrade would wipe the secrets.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This module compiles to dist/util/envfile.js (and runs from src/util/ under
// tsx) — two levels below the package root either way.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function xdgLoomDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'loom');
}

/** All places a .env may live, in precedence order (may not exist). */
export function envFileCandidates(): string[] {
  const out: string[] = [];
  if (process.env.LOOM_ENV) out.push(process.env.LOOM_ENV);
  out.push(join(xdgLoomDir(), '.env'), join(PACKAGE_ROOT, '.env'));
  return out;
}

/** The .env files that actually exist, in precedence order. */
export function envFilesForRead(): string[] {
  return envFileCandidates().filter((p) => existsSync(p));
}

/** Where to write secrets: first existing candidate, else LOOM_ENV/XDG. */
export function envFileForWrite(): string {
  const existing = envFilesForRead();
  if (existing.length > 0) return existing[0];
  const target = process.env.LOOM_ENV || join(xdgLoomDir(), '.env');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

/** credentials.json (expiry metadata, no secrets) follows the same rule. */
export function registryFileForRead(): string | undefined {
  return registryCandidates().find((p) => existsSync(p));
}

export function registryFileForWrite(): string {
  const existing = registryFileForRead();
  if (existing) return existing;
  const target = registryCandidates()[0];
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

function registryCandidates(): string[] {
  return [join(xdgLoomDir(), 'credentials.json'), join(PACKAGE_ROOT, 'credentials.json')];
}
