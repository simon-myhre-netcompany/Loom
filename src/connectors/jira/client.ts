/**
 * Jira Cloud REST client (read-only). Basic auth = base64(email:apiToken).
 * Uses the current enhanced search endpoint POST /rest/api/3/search/jql with
 * nextPageToken pagination.
 */
import { fetchJson } from '../../util/http.js';

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

function authHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

interface SearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

export async function searchIssues(params: SearchParams): Promise<JiraIssue[]> {
  const { base, email, token, jql, fields, pageLimit = 10 } = params;
  const url = `${base}/rest/api/3/search/jql`;
  const headers = { Authorization: authHeader(email, token) };

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
