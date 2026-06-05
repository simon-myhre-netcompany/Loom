/**
 * Tempo Cloud API client (read-only).
 *
 * Endpoint and pagination behaviour mirror the proven approach in the JTI
 * extension: GET /4/worklogs/user/{accountId}?from=&to=, Bearer token, follow
 * `metadata.next`.
 */
import { fetchPaginated } from '../../util/http.js';

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
