/**
 * Confluence connector — command handlers. Read-only.
 *
 *   loom confluence pages [--since 30d] [--until YYYY-MM-DD] [--cql "..."]
 *
 * Default scope: pages/blogposts you've contributed to, modified in the range
 * (your weekly status page, recent edits). Override with --cql.
 */
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import { resolveAtlassianAuth, requireConfluenceBase } from '../../util/atlassian.js';
import {
  searchContent,
  getPageById,
  findPageByTitle,
  type ConfluenceContent,
} from './client.js';

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'pages':
    case undefined:
      return pages(argv);
    case 'page':
      return page(argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

/**
 * loom confluence page (--id <pageId> | --title "<title>" [--space KEY])
 *
 * Fetch a single page's content. Exactly one of --id / --title is required.
 * `--json` emits {id, title, space, url, version, body} where body is the
 * storage-format HTML; the human view strips tags to plain text.
 */
async function page(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const base = requireConfluenceBase(flags);
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      'Missing Atlassian credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN. ' +
        'Run `loom guide confluence` for how to get them.'
    );
  }
  const { email, token } = auth;

  const id = typeof flags.id === 'string' ? flags.id.trim() : '';
  const title = typeof flags.title === 'string' ? flags.title.trim() : '';
  if ((!id && !title) || (id && title)) {
    throw usage('page: pass exactly one of --id <pageId> or --title "<title>"');
  }
  const space = typeof flags.space === 'string' ? flags.space.trim() : undefined;

  let pageId = id;
  if (!pageId) {
    const found = await findPageByTitle(base, email, token, title, space);
    if (!found) {
      throw new Error(
        `confluence page: no page found matching title "${title}"` +
          (space ? ` in space ${space}` : '') + '.'
      );
    }
    pageId = found;
  }

  const p = await getPageById(base, email, token, pageId);
  return [
    {
      timestamp: '',
      source: 'confluence',
      type: 'page',
      ref: p.id,
      title: `${p.title}${p.spaceKey ? ` [${p.spaceKey}]` : ''}`,
      body: stripTags(p.body),
      url: p.url,
      raw: {
        id: p.id,
        title: p.title,
        space: p.spaceKey ?? null,
        url: p.url,
        version: p.version ?? null,
        body: p.body,
      },
    },
  ];
}

/** Crude storage-format → plain text: drop tags, decode a few entities, tidy whitespace. */
function stripTags(html: string): string {
  return html
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pages(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const base = requireConfluenceBase(flags);
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      'Missing Atlassian credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN. ' +
        'Run `loom guide confluence` for how to get them.'
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
      'usage:\n' +
      '  loom confluence pages [--since 30d] [--until YYYY-MM-DD] [--cql "..."]\n' +
      '  loom confluence page  (--id <pageId> | --title "<title>" [--space KEY])'
  );
}
