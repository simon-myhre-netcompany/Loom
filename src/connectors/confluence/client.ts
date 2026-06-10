/**
 * Confluence Cloud REST client (read-only). Same Atlassian Basic auth as Jira.
 * Uses CQL content search with _links.next pagination.
 */
import { fetchJson } from '../../util/http.js';
import { basicAuthHeader } from '../../util/atlassian.js';


export interface ConfluenceContent {
  id: string;
  type: string; // page | blogpost | whiteboard ...
  title: string;
  /** Absolute web URL, assembled from the response base + webui link. */
  url: string;
  /** Last-modified timestamp (version.when). */
  when?: string;
  /** Who last modified it. */
  by?: string;
  spaceKey?: string;
}

export interface SearchParams {
  base: string;
  email: string;
  token: string;
  cql: string;
  pageLimit?: number;
}

interface RawResult {
  id: string;
  type: string;
  title: string;
  version?: { when?: string; by?: { displayName?: string } };
  space?: { key?: string };
  _links?: { webui?: string };
}

interface SearchResponse {
  results?: RawResult[];
  _links?: { next?: string; base?: string };
}

export async function searchContent(params: SearchParams): Promise<ConfluenceContent[]> {
  const { base, email, token, cql, pageLimit = 10 } = params;
  const headers = { Authorization: basicAuthHeader(email, token) };
  const origin = new URL(base).origin;

  const start = `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=50&expand=version,space`;
  let next: string | undefined = start;
  let pages = 0;
  const out: ConfluenceContent[] = [];

  while (next && pages < pageLimit) {
    const res: SearchResponse = await fetchJson(next, { headers });
    const webBase = res._links?.base ?? base;
    for (const r of res.results ?? []) {
      out.push({
        id: r.id,
        type: r.type,
        title: r.title,
        url: r._links?.webui ? webBase + r._links.webui : webBase,
        when: r.version?.when,
        by: r.version?.by?.displayName,
        spaceKey: r.space?.key,
      });
    }
    // _links.next is a site-relative path (e.g. /wiki/rest/api/content/search?...).
    next = res._links?.next ? origin + res._links.next : undefined;
    pages++;
  }
  return out;
}
