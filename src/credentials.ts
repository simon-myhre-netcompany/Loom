/**
 * Credential registry & expiry tracking.
 *
 * Secrets live in environment variables (.env for now). This registry holds
 * only *metadata* — which env vars we expect and when each one expires — so we
 * can answer "does any API key expire soon?" without ever storing the secret.
 *
 * Stored in credentials.json next to .env — ~/.config/loom/ for global
 * installs, the project root for repo clones (see util/envfile.ts). It holds
 * no secrets, but it is personal state (which tokens you have, when they
 * expire) — gitignored.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { envFileForWrite, registryFileForRead, registryFileForWrite } from './util/envfile.js';

export interface CredentialEntry {
  /** Environment variable holding the secret. */
  env: string;
  /** Human label. */
  label?: string;
  /** Which connector it belongs to. */
  source?: string;
  /** Expiry as YYYY-MM-DD, or null if it never expires. */
  expires: string | null;
}

export type CredentialState = 'ok' | 'soon' | 'expired' | 'never' | 'missing';

export interface CredentialStatus extends CredentialEntry {
  /** Whether the env var is currently set. */
  present: boolean;
  /** Days until expiry (negative if past). null when no expiry / unparseable. */
  daysLeft: number | null;
  state: CredentialState;
}

/** Threshold (days) under which a key is considered "expiring soon". */
export const SOON_DAYS = 30;

/**
 * Parse env-file text into name/value pairs. The format (same one the CLI
 * loads at startup): one NAME=VALUE per line; `#` comments and blank lines
 * ignored; the value is everything after the FIRST `=`, taken verbatim after
 * trimming — no quote stripping, no `export` prefix, no multi-line values.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Merge every NAME=VALUE from `pairs` into the resolved .env in one write —
 * existing NAME= lines replaced in place, new ones appended, everything else
 * (comments, unrelated vars) left untouched. Created 0600 when missing.
 * Returns the path written. Also updates process.env for this run.
 */
export function importEnvSecrets(pairs: Record<string, string>): string {
  const envPath = envFileForWrite();
  let text = '';
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    /* no .env yet — we'll create it */
  }
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  for (const [name, value] of Object.entries(pairs)) {
    const idx = lines.findIndex((l) => l.trimStart().startsWith(`${name}=`));
    if (idx >= 0) lines[idx] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
    process.env[name] = value;
  }
  writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
  return envPath;
}

/**
 * Store one NAME=value in the resolved .env (see importEnvSecrets).
 * Returns the path written.
 */
export function setEnvSecret(name: string, value: string): string {
  return importEnvSecrets({ [name]: value });
}

interface RegistryFile {
  credentials: CredentialEntry[];
}

export function loadRegistry(): CredentialEntry[] {
  const path = registryFileForRead();
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RegistryFile;
    return Array.isArray(parsed.credentials) ? parsed.credentials : [];
  } catch {
    return [];
  }
}

export function saveRegistry(entries: CredentialEntry[]): void {
  const body = JSON.stringify({ credentials: entries }, null, 2) + '\n';
  writeFileSync(registryFileForWrite(), body, 'utf8');
}

/** Add or replace an entry (keyed by env), then persist. */
export function upsertEntry(entry: CredentialEntry): CredentialEntry[] {
  const entries = loadRegistry().filter((e) => e.env !== entry.env);
  entries.push(entry);
  entries.sort((a, b) => a.env.localeCompare(b.env));
  saveRegistry(entries);
  return entries;
}

export function computeStatus(entry: CredentialEntry, now: Date = new Date()): CredentialStatus {
  const present = !!process.env[entry.env];
  let daysLeft: number | null = null;
  let state: CredentialState;

  if (!present) {
    state = 'missing';
  } else if (entry.expires === null) {
    state = 'never';
  } else {
    const exp = new Date(`${entry.expires}T23:59:59`);
    if (isNaN(exp.getTime())) {
      daysLeft = null;
      state = 'ok';
    } else {
      daysLeft = Math.ceil((exp.getTime() - now.getTime()) / 86_400_000);
      state = daysLeft < 0 ? 'expired' : daysLeft <= SOON_DAYS ? 'soon' : 'ok';
    }
  }
  return { ...entry, present, daysLeft, state };
}

export function statusReport(now: Date = new Date()): CredentialStatus[] {
  return loadRegistry()
    .map((e) => computeStatus(e, now))
    .sort((a, b) => rank(a.state) - rank(b.state));
}

function rank(s: CredentialState): number {
  return { expired: 0, missing: 1, soon: 2, ok: 3, never: 4 }[s];
}
