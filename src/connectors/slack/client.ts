/**
 * Slack Web API client (read-only). User token (xoxp-) Bearer auth.
 * Slack returns HTTP 200 with {ok:false,error} on logical errors, so we check
 * the `ok` field rather than the HTTP status.
 */
const SLACK_API = 'https://slack.com/api';

async function slackGet<T>(method: string, params: Record<string, string>, token: string): Promise<T> {
  const url = `${SLACK_API}/${method}?${new URLSearchParams(params)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new Error(`Network error contacting slack.com: ${(err as Error).message}`);
  }
  const data = (await res.json()) as T & { ok: boolean; error?: string };
  if (!data.ok) {
    const e = data.error ?? 'unknown_error';
    const hint =
      e === 'missing_scope'
        ? ' (the token lacks search:read — re-check User Token Scopes)'
        : e === 'not_allowed_token_type'
          ? ' (need a user token xoxp-, not a bot token)'
          : '';
    throw new Error(`Slack API ${method} failed: ${e}${hint}`);
  }
  return data;
}

export interface SlackMatch {
  ts: string;
  text: string;
  username?: string;
  permalink?: string;
  channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean };
}

interface SearchResponse {
  messages: {
    total: number;
    matches: SlackMatch[];
    paging: { count: number; total: number; page: number; pages: number };
  };
}

export async function whoAmI(token: string): Promise<{ user: string; team: string }> {
  return slackGet<{ user: string; team: string }>('auth.test', {}, token);
}

/** Run a search.messages query, following pages up to pageLimit. */
export async function searchMessages(
  token: string,
  query: string,
  pageLimit = 5
): Promise<SlackMatch[]> {
  const matches: SlackMatch[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await slackGet<SearchResponse>(
      'search.messages',
      { query, count: '100', page: String(page), sort: 'timestamp' },
      token
    );
    matches.push(...(res.messages.matches ?? []));
    pages = res.messages.paging.pages;
    page++;
  } while (page <= pages && page <= pageLimit);
  return matches;
}
