/**
 * Jira Cloud REST client (read-only). Basic auth = base64(email:apiToken).
 * Uses the current enhanced search endpoint POST /rest/api/3/search/jql with
 * nextPageToken pagination.
 */
import { fetchJson, fetchVoid } from '../../util/http.js';
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

// ---------------------------------------------------------------------------
// Write helpers (guarded in index.ts). All act as the authenticated user — the
// Basic-auth account — so there is no way to write on someone else's behalf.
// Use the v2 endpoints so bodies are plain strings (no ADF wrapping).
// ---------------------------------------------------------------------------

/** A fuller read of one issue, used to preview a write (current → new). */
export interface JiraIssueDetail {
  id: number;
  key: string;
  summary?: string;
  status?: string;
  description?: string;
  assignee?: string;
  originalEstimate?: string;
  remainingEstimate?: string;
  labels?: string[];
  priority?: string;
  duedate?: string;
}

export async function getIssueDetail(
  base: string,
  email: string,
  token: string,
  key: string
): Promise<JiraIssueDetail> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const issue = await fetchJson<{
    id: string;
    key: string;
    fields?: {
      summary?: string;
      status?: { name?: string };
      description?: string | null;
      assignee?: { displayName?: string } | null;
      timetracking?: { originalEstimate?: string; remainingEstimate?: string };
      labels?: string[];
      priority?: { name?: string } | null;
      duedate?: string | null;
    };
  }>(
    `${base}/rest/api/2/issue/${encodeURIComponent(key)}` +
      `?fields=summary,status,description,assignee,timetracking,labels,priority,duedate`,
    { headers }
  );
  const f = issue.fields ?? {};
  return {
    id: Number(issue.id),
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    description: f.description ?? undefined,
    assignee: f.assignee?.displayName ?? undefined,
    originalEstimate: f.timetracking?.originalEstimate,
    remainingEstimate: f.timetracking?.remainingEstimate,
    labels: f.labels ?? [],
    priority: f.priority?.name ?? undefined,
    duedate: f.duedate ?? undefined,
  };
}

/** All priority names defined on this Jira instance (for validating --priority). */
export async function getPriorities(
  base: string,
  email: string,
  token: string
): Promise<string[]> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const ps = await fetchJson<Array<{ name?: string }>>(`${base}/rest/api/2/priority`, { headers });
  return ps.map((p) => p.name).filter((n): n is string => !!n);
}

/** A user resolved from a name/email query, for assignment. */
export interface JiraUser {
  accountId: string;
  displayName?: string;
}

/**
 * Find a single user by name or email (for --assign). Returns the first match,
 * or null if none. Uses the Cloud user search endpoint.
 */
export async function findUser(
  base: string,
  email: string,
  token: string,
  query: string
): Promise<JiraUser | null> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const users = await fetchJson<Array<{ accountId: string; displayName?: string }>>(
    `${base}/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=2`,
    { headers }
  );
  if (!users.length) return null;
  return { accountId: users[0].accountId, displayName: users[0].displayName };
}

/** Read one (possibly custom) field's raw value off an issue. */
export async function getIssueFieldValue(
  base: string,
  email: string,
  token: string,
  key: string,
  fieldId: string
): Promise<unknown> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const issue = await fetchJson<{ fields?: Record<string, unknown> }>(
    `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fieldId)}`,
    { headers }
  );
  return issue.fields?.[fieldId];
}

/** Post a comment (plain text). Returns the created comment. */
export async function addComment(
  base: string,
  email: string,
  token: string,
  key: string,
  body: string
): Promise<JiraComment> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  return fetchJson<JiraComment>(
    `${base}/rest/api/2/issue/${encodeURIComponent(key)}/comment`,
    { method: 'POST', headers, body: JSON.stringify({ body }) }
  );
}

/** A status transition available from the issue's current status. */
export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

/** The transitions currently available on an issue (depends on its status). */
export async function getTransitions(
  base: string,
  email: string,
  token: string,
  key: string
): Promise<JiraTransition[]> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const res = await fetchJson<{ transitions?: JiraTransition[] }>(
    `${base}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
    { headers }
  );
  return res.transitions ?? [];
}

/** Apply a status transition by its id. Returns 204 (no body). */
export async function transitionIssue(
  base: string,
  email: string,
  token: string,
  key: string,
  transitionId: string
): Promise<void> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  await fetchVoid(`${base}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
}

/** Update arbitrary issue fields (description, timetracking, ...). 204, no body. */
export async function updateIssueFields(
  base: string,
  email: string,
  token: string,
  key: string,
  fields: Record<string, unknown>
): Promise<void> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  await fetchVoid(`${base}/rest/api/2/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ fields }),
  });
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
