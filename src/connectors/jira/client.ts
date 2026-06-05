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
