/**
 * Credential registry & expiry tracking.
 *
 * Secrets live in environment variables (.env for now). This registry holds
 * only *metadata* — which env vars we expect and when each one expires — so we
 * can answer "does any API key expire soon?" without ever storing the secret.
 *
 * Stored in credentials.json at the project root. It holds no secrets, but it
 * is personal state (which tokens you have, when they expire) — gitignored.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const REGISTRY_PATH = fileURLToPath(new URL('../credentials.json', import.meta.url));

interface RegistryFile {
  credentials: CredentialEntry[];
}

export function loadRegistry(): CredentialEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryFile;
    return Array.isArray(parsed.credentials) ? parsed.credentials : [];
  } catch {
    return [];
  }
}

export function saveRegistry(entries: CredentialEntry[]): void {
  const body = JSON.stringify({ credentials: entries }, null, 2) + '\n';
  writeFileSync(REGISTRY_PATH, body, 'utf8');
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
