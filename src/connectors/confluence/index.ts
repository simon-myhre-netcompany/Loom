/**
 * Confluence connector — command handlers. Read-only.
 *
 *   logger confluence pages [--since 30d] [--until YYYY-MM-DD] [--cql "..."]
 *
 * Default scope: pages/blogposts you've contributed to, modified in the range
 * (your weekly status page, recent edits). Override with --cql.
 */
import type { ActivityEvent } from '../../types.js';
import { flagOrEnv, parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import { resolveAtlassianAuth } from '../../util/atlassian.js';
import { searchContent, DEFAULT_CONFLUENCE_BASE, type ConfluenceContent } from './client.js';

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'pages':
    case undefined:
      return pages(argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function pages(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const base = flagOrEnv(flags, 'base', 'CONFLUENCE_BASE_URL', DEFAULT_CONFLUENCE_BASE)!;
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      'Missing Atlassian credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN. ' +
        'Run `logger guide confluence` for how to get them.'
    );
  }
  const { email, token } = auth;

  const sinceStr = typeof flags.since === 'string' ? flags.since : '30d';
  const from = toDateString(parseSince(sinceStr));

  const cql =
    typeof flags.cql === 'string'
      ? flags.cql
      : `contributor = currentUser() and type in (page, blogpost) ` +
        `and lastmodified >= "${from}" order by lastmodified desc`;

  const raw = await searchContent({ base, email, token, cql });
  return raw.map(toEvent);
}

function toEvent(c: ConfluenceContent): ActivityEvent {
  return {
    timestamp: c.when ?? '',
    source: 'confluence',
    type: c.type, // page | blogpost | whiteboard
    ref: c.id,
    title: `${c.title}${c.spaceKey ? ` [${c.spaceKey}]` : ''}`,
    body: c.by ? `last edited by ${c.by}` : undefined,
    url: c.url,
    raw: c,
  };
}

function usage(reason: string): Error {
  return new Error(
    `confluence: ${reason}\n` +
      'usage: logger confluence pages [--since 30d] [--until YYYY-MM-DD] [--cql "..."]'
  );
}
