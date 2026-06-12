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
        ? method.startsWith('conversations.')
          ? ' (the token lacks channel scopes — add channels:read + channels:history' +
            ' (and groups:read + groups:history for private channels) under' +
            ' User Token Scopes, then reinstall the app to the workspace)'
          : ' (the token lacks search:read — re-check User Token Scopes)'
        : e === 'not_allowed_token_type'
          ? ' (need a user token xoxp-, not a bot token)'
          : e === 'not_in_channel'
            ? ' (you must be a member of the channel to read its history)'
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
  blocks?: unknown[];
  attachments?: { title?: string; text?: string; fallback?: string }[];
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

export interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
}

interface ListResponse {
  channels: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}

/**
 * Resolve a channel name to its id via conversations.list (needs channels:read;
 * groups:read to also see private channels).
 */
export async function findChannel(token: string, name: string): Promise<SlackChannel> {
  const want = name.replace(/^#/, '').toLowerCase();
  let cursor = '';
  do {
    const res = await slackGet<ListResponse>(
      'conversations.list',
      {
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      },
      token
    );
    const hit = res.channels.find((c) => c.name.toLowerCase() === want);
    if (hit) return hit;
    cursor = res.response_metadata?.next_cursor ?? '';
  } while (cursor);
  throw new Error(`channel "#${want}" not found (or this token's workspace cannot see it)`);
}

/** One raw message from conversations.history. Thread replies are not included. */
export interface SlackHistoryMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  blocks?: unknown[];
  attachments?: { title?: string; text?: string; fallback?: string }[];
}

interface HistoryResponse {
  messages: SlackHistoryMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/**
 * Every message in a channel between two unix timestamps (needs
 * channels:history; groups:history for private channels). Newest first,
 * paginated up to pageLimit pages of 200.
 */
export async function channelHistory(
  token: string,
  channelId: string,
  oldest?: string,
  latest?: string,
  pageLimit = 20
): Promise<SlackHistoryMessage[]> {
  const out: SlackHistoryMessage[] = [];
  let cursor = '';
  let pages = 0;
  do {
    const res = await slackGet<HistoryResponse>(
      'conversations.history',
      {
        channel: channelId,
        limit: '200',
        inclusive: 'true',
        ...(oldest ? { oldest } : {}),
        ...(latest ? { latest } : {}),
        ...(cursor ? { cursor } : {}),
      },
      token
    );
    out.push(...(res.messages ?? []));
    cursor = res.has_more ? (res.response_metadata?.next_cursor ?? '') : '';
  } while (cursor && ++pages < pageLimit);
  return out;
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
