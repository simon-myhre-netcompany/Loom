/**
 * Tempo Cloud API client.
 *
 * Reads (GET /4/worklogs[/user/{accountId}]?from=&to=) mirror the proven
 * approach in the JTI extension: Bearer token, follow `metadata.next`.
 *
 * Writes (POST /4/worklogs) are gated by the connector on having an explicit
 * account id, so we only ever create worklogs under that author — never anyone
 * else's. See `createWorklog` and the `log` action in index.ts.
 */
import { fetchJson, fetchPaginated } from '../../util/http.js';

export const TEMPO_API_BASE = 'https://api.eu.tempo.io/4';

/** Subset of the Tempo v4 worklog payload we rely on. */
export interface TempoWorklog {
  tempoWorklogId?: number;
  jiraWorklogId?: number;
  issue?: { id?: number; self?: string };
  timeSpentSeconds?: number;
  billableSeconds?: number;
  startDate?: string; // YYYY-MM-DD
  startTime?: string; // HH:mm:ss
  startDateTimeUtc?: string; // ISO-8601 with Z
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  author?: { accountId?: string; self?: string };
}

/** A Tempo Account (billing/cost bucket worklogs are booked against). */
export interface TempoAccount {
  id: number;
  key: string;
  name: string;
  status?: string;
  global?: boolean;
  customer?: { name?: string; key?: string };
  category?: { name?: string };
  lead?: { accountId?: string };
}

/** All Tempo accounts the token can see (paginated). */
export async function getAccounts(token: string): Promise<TempoAccount[]> {
  return fetchPaginated<TempoAccount>(`${TEMPO_API_BASE}/accounts`, { token });
}

export interface GetWorklogsParams {
  token: string;
  /** When set, scope to this user. Otherwise fetch all worklogs the token sees. */
  accountId?: string;
  /** Inclusive start date, YYYY-MM-DD. */
  from: string;
  /** Inclusive end date, YYYY-MM-DD. */
  to: string;
}

export async function getWorklogs(params: GetWorklogsParams): Promise<TempoWorklog[]> {
  const { token, accountId, from, to } = params;
  const path = accountId
    ? `/worklogs/user/${encodeURIComponent(accountId)}`
    : '/worklogs';
  const url = `${TEMPO_API_BASE}${path}?from=${from}&to=${to}`;
  return fetchPaginated<TempoWorklog>(url, { token });
}

export interface CreateWorklogParams {
  token: string;
  /** Whose worklog this is. Required — the connector refuses to write without it. */
  authorAccountId: string;
  /** Numeric Jira issue id (NOT the key — resolve keys via the Jira client first). */
  issueId: number;
  timeSpentSeconds: number;
  /** YYYY-MM-DD. */
  startDate: string;
  /** HH:mm:ss. */
  startTime: string;
  description: string;
}

/**
 * Create a single worklog (POST /4/worklogs). Returns the created worklog as
 * Tempo echoes it back, so the caller can render it like a fetched one.
 */
export async function createWorklog(params: CreateWorklogParams): Promise<TempoWorklog> {
  const { token, ...body } = params;
  return fetchJson<TempoWorklog>(`${TEMPO_API_BASE}/worklogs`, {
    method: 'POST',
    token,
    body: JSON.stringify(body),
  });
}
