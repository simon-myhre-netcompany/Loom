/**
 * GitHub REST API client (read-only).
 *
 * Uses the Search API so a single token returns activity across every repo it
 * can access (personal + org), and we merge results from multiple tokens. The
 * authenticated login is discovered from each token via GET /user, so the
 * caller never has to supply a username.
 */
const GITHUB_API = 'https://api.github.com';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'loom-cli',
  };
}

async function ghFetch(url: string, token: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: ghHeaders(token) });
  } catch (err) {
    throw new Error(`Network error contacting api.github.com: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `GitHub denied the request (${res.status}). Check the PAT and its scopes ` +
          `(Metadata + Contents + Pull requests, read-only). Run \`loom guide github\`.` +
          (body ? `\n${body.slice(0, 200)}` : '')
      );
    }
    throw new Error(`GitHub request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res;
}

/** The login (username) the token authenticates as. */
export async function getLogin(token: string): Promise<string> {
  const res = await ghFetch(`${GITHUB_API}/user`, token);
  const user = (await res.json()) as { login: string };
  return user.login;
}

interface SearchPage<T> {
  items: T[];
}

/**
 * Run a Search API query, following Link rel="next" until exhausted.
 * `path` is e.g. "/search/issues". `q` is the raw query string (un-encoded).
 */
async function searchAll<T>(path: string, q: string, token: string): Promise<T[]> {
  let url: string | undefined = `${GITHUB_API}${path}?q=${encodeURIComponent(q)}&per_page=100`;
  const items: T[] = [];
  while (url) {
    const res = await ghFetch(url, token);
    const page = (await res.json()) as SearchPage<T>;
    items.push(...(page.items ?? []));
    url = parseNextLink(res.headers.get('link'));
  }
  return items;
}

function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return undefined;
}

export interface GhPr {
  number: number;
  title: string;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

export interface GhCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { date: string } };
  repository: { full_name: string };
}

/** PRs authored by `login`, with activity in the date range (YYYY-MM-DD). */
export function searchAuthoredPRs(
  token: string,
  login: string,
  from: string,
  to: string
): Promise<GhPr[]> {
  return searchAll<GhPr>('/search/issues', `author:${login} type:pr updated:${from}..${to}`, token);
}

/** Commits authored by `login` in the date range (default branches only). */
export function searchAuthoredCommits(
  token: string,
  login: string,
  from: string,
  to: string
): Promise<GhCommit[]> {
  return searchAll<GhCommit>('/search/commits', `author:${login} author-date:${from}..${to}`, token);
}
