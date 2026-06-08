/**
 * Slack connector — command handlers. Read-only.
 *
 *   loom slack messages [--since 7d] [--until YYYY-MM-DD]
 *
 * Finds messages YOU sent (search.messages `from:me`) across every workspace
 * token configured as SLACK_TOKEN / SLACK_TOKEN_* — merged and deduped.
 */
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import { searchMessages, type SlackMatch } from './client.js';

interface NamedToken {
  label: string;
  token: string;
}

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'messages':
    case undefined:
      return messages(argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function messages(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);
  const tokens = collectTokens(flags);
  if (tokens.length === 0) {
    throw new Error(
      'No Slack token. Set SLACK_TOKEN (and/or SLACK_TOKEN_<NAME> for more ' +
        'workspaces) or pass --token. Run `loom guide slack` for how to get one.'
    );
  }

  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const until = typeof flags.until === 'string' ? flags.until : undefined;

  // Slack search date modifiers: after:/before: are exclusive day boundaries.
  let query = `from:me after:${from}`;
  if (until) query += ` before:${until}`;

  const perToken = await Promise.all(
    tokens.map(async (t) => (await searchMessages(t.token, query)).map((m) => toEvent(m)))
  );
  return dedupe(perToken.flat());
}

function toEvent(m: SlackMatch): ActivityEvent {
  const channel =
    m.channel.is_im ? 'DM' : m.channel.is_mpim ? 'group DM' : m.channel.name ?? m.channel.id;
  const seconds = parseFloat(m.ts);
  const timestamp = Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : '';
  const text = (m.text ?? '').replace(/\s+/g, ' ').trim();

  return {
    timestamp,
    source: 'slack',
    type: 'message',
    ref: `${m.channel.id}:${m.ts}`,
    title: `#${channel}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    body: text || undefined,
    url: m.permalink,
    raw: m,
  };
}

function collectTokens(flags: Record<string, string | boolean>): NamedToken[] {
  if (typeof flags.token === 'string') return [{ label: 'flag', token: flags.token }];
  const out: NamedToken[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (key === 'SLACK_TOKEN') out.push({ label: 'default', token: value });
    else if (key.startsWith('SLACK_TOKEN_'))
      out.push({ label: key.slice('SLACK_TOKEN_'.length).toLowerCase(), token: value });
  }
  return out;
}

function dedupe(events: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = e.url ?? e.ref;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function usage(reason: string): Error {
  return new Error(
    `slack: ${reason}\nusage: loom slack messages [--since 7d] [--until YYYY-MM-DD]`
  );
}
