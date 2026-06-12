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

/** A single page's content, fetched by id (for `loom confluence page`). */
export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey?: string;
  url: string;
  version?: number;
  /** Storage-format body (HTML-ish XML). */
  body: string;
}

interface RawPage {
  id: string;
  title: string;
  space?: { key?: string };
  version?: { number?: number };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}

/**
 * Fetch one page by id, with its storage-format body, version and space.
 * The classic content endpoint; expand body.storage so we get the HTML.
 */
export async function getPageById(
  base: string,
  email: string,
  token: string,
  id: string
): Promise<ConfluencePage> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const origin = new URL(base).origin;
  const r = await fetchJson<RawPage>(
    `${base}/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space`,
    { headers }
  );
  const webBase = r._links?.base ?? base;
  return {
    id: r.id,
    title: r.title,
    spaceKey: r.space?.key,
    url: r._links?.webui ? webBase + r._links.webui : webBase,
    version: r.version?.number,
    body: r.body?.storage?.value ?? '',
  };
}

/**
 * Find a page id by title (optionally scoped to a space), via CQL content
 * search. Returns the best match's id, or null when nothing matches.
 */
export async function findPageByTitle(
  base: string,
  email: string,
  token: string,
  title: string,
  spaceKey?: string
): Promise<string | null> {
  const headers = { Authorization: basicAuthHeader(email, token) };
  const escaped = title.replace(/"/g, '\\"');
  const cql =
    `title ~ "${escaped}" and type = page` + (spaceKey ? ` and space = ${spaceKey}` : '');
  const res = await fetchJson<SearchResponse>(
    `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=10`,
    { headers }
  );
  const results = res.results ?? [];
  if (!results.length) return null;
  // Prefer an exact (case-insensitive) title match, else the first hit.
  const exact = results.find((r) => r.title.trim().toLowerCase() === title.trim().toLowerCase());
  return (exact ?? results[0]).id;
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
