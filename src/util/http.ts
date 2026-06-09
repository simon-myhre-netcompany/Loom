/**
 * Small fetch helpers shared by connectors. Node 18+ has global `fetch`.
 */

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  token?: string;
}

function buildHeaders(opts: FetchOptions): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
}

/** Fetch JSON with friendly errors. Throws on non-2xx. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: buildHeaders(opts),
      body: opts.body,
    });
  } catch (err) {
    throw new Error(`Network error contacting ${hostOf(url)}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Access denied by ${hostOf(url)} (${res.status}). Check the API token / scopes.`
      );
    }
    throw new Error(
      `Request to ${hostOf(url)} failed (${res.status} ${res.statusText})` +
        (detail ? `: ${detail.slice(0, 300)}` : '')
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Like `fetchJson`, but for write requests whose success body is empty or
 * uninteresting (Jira PUT/POST transitions return 204 No Content). Throws on
 * non-2xx with the same friendly errors; returns nothing.
 */
export async function fetchVoid(url: string, opts: FetchOptions = {}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: buildHeaders(opts),
      body: opts.body,
    });
  } catch (err) {
    throw new Error(`Network error contacting ${hostOf(url)}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Access denied by ${hostOf(url)} (${res.status}). Check the API token / permissions.`
      );
    }
    throw new Error(
      `Request to ${hostOf(url)} failed (${res.status} ${res.statusText})` +
        (detail ? `: ${detail.slice(0, 300)}` : '')
    );
  }
}

/**
 * Fetch a paginated Tempo-style endpoint that returns
 * `{ results: T[], metadata: { next?: string } }`, following `metadata.next`
 * until exhausted. Returns the concatenated `results`.
 */
export async function fetchPaginated<T = unknown>(
  url: string,
  opts: FetchOptions = {}
): Promise<T[]> {
  let next: string | undefined = url;
  const all: T[] = [];
  while (next) {
    const page: { results: T[]; metadata?: { next?: string } } = await fetchJson(next, opts);
    all.push(...(page.results ?? []));
    next = page.metadata?.next;
  }
  return all;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the server';
  }
}
