/**
 * Jira Cloud REST client (read-only). Basic auth = base64(email:apiToken).
 * Uses the current enhanced search endpoint POST /rest/api/3/search/jql with
 * nextPageToken pagination.
 */
import { fetchJson } from '../../util/http.js';
import { basicAuthHeader } from '../../util/atlassian.js';

export const DEFAULT_JIRA_BASE = 'https://oslo-kommune.atlassian.net';

export interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    duedate?: string | null;
    created?: string;
    updated?: string;
  };
}

export interface SearchParams {
  base: string;
  email: string;
  token: string;
  jql: string;
  fields: string[];
  /** Safety cap on pages (100 issues each). */
  pageLimit?: number;
}

interface SearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

export interface JiraComment {
  id: string;
  author?: { accountId?: string; displayName?: string };
  body?: string; // v2 endpoint returns a plain string
  created?: string;
  updated?: string;
}

/** The authenticated user's accountId. */
export async function getMyAccountId(base: string, email: string, token: string): Promise<string> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const me = await fetchJson<{ accountId: string }>(`${base}/rest/api/3/myself`, { headers });
  return me.accountId;
}

/** An issue's stable numeric id + summary, looked up from its key. */
export interface IssueRef {
  id: number;
  key: string;
  summary?: string;
}

/**
 * Resolve a human issue key (e.g. "TIL-123") to its numeric id — the id Tempo's
 * write API requires. `summary` comes along for free so callers can use it.
 */
export async function getIssueRef(
  base: string,
  email: string,
  token: string,
  key: string
): Promise<IssueRef> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const issue = await fetchJson<{ id: string; key: string; fields?: { summary?: string } }>(
    `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
    { headers }
  );
  return { id: Number(issue.id), key: issue.key, summary: issue.fields?.summary };
}

/**
 * All comments on an issue, via the v2 endpoint (plain-string bodies — no ADF).
 * Paginated by startAt/total.
 */
export async function getComments(
  base: string,
  email: string,
  token: string,
  issueKey: string
): Promise<JiraComment[]> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const out: JiraComment[] = [];
  let startAt = 0;
  for (let page = 0; page < 20; page++) {
    const res = await fetchJson<{ comments?: JiraComment[]; total?: number; maxResults?: number }>(
      `${base}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=100`,
      { headers }
    );
    out.push(...(res.comments ?? []));
    startAt += res.maxResults ?? 100;
    if (startAt >= (res.total ?? 0)) break;
  }
  return out;
}

export async function searchIssues(params: SearchParams): Promise<JiraIssue[]> {
  const { base, email, token, jql, fields, pageLimit = 10 } = params;
  const url = `${base}/rest/api/3/search/jql`;
  const headers = { Authorization: basicAuthHeader(email, token) };

  const all: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  let pages = 0;
  do {
    const body = JSON.stringify({
      jql,
      maxResults: 100,
      fields,
      ...(nextPageToken ? { nextPageToken } : {}),
    });
    const res: SearchResponse = await fetchJson(url, { method: 'POST', headers, body });
    all.push(...(res.issues ?? []));
    nextPageToken = res.nextPageToken;
    pages++;
  } while (nextPageToken && pages < pageLimit);
  return all;
}
