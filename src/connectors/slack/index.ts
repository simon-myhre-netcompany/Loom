/**
 * Slack connector — command handlers. Read-only.
 *
 *   loom slack messages [--since 7d] [--until DATE] [--channel C] [--from U] [--query "..."]
 *   loom slack history  --channel C [--since 7d] [--until DATE]
 *
 * `messages` uses search.messages across every workspace token configured as
 * SLACK_TOKEN / SLACK_TOKEN_* — merged and deduped. With no filter it defaults
 * to messages YOU sent (`from:me`); --channel/--from/--query search anything
 * your user can see (needs only search:read).
 *
 * `history` walks one channel completely via conversations.history — exact
 * time window, includes every bot/app post (search can lag or skip these).
 * Needs channels:read + channels:history (groups:* for private channels).
 */
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, parseDateOnly, toDateString } from '../../util/time.js';
import {
  searchMessages,
  findChannel,
  channelHistory,
  type SlackMatch,
  type SlackHistoryMessage,
} from './client.js';

interface NamedToken {
  label: string;
  token: string;
}

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'messages':
    case undefined:
      return messages(argv);
    case 'history':
      return history(argv);
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
  const until = typeof flags.until === 'string' ? flags.until : undefined;

  // Optional filters. With none given the historical default applies: your
  // own messages. Any filter searches everything your user can see.
  const channel = typeof flags.channel === 'string' ? flags.channel : undefined;
  const from = typeof flags.from === 'string' ? flags.from : undefined;
  const text = typeof flags.query === 'string' ? flags.query : undefined;

  const parts: string[] = [];
  if (text) parts.push(text);
  if (from) parts.push(from === 'me' ? 'from:me' : `from:@${from.replace(/^@/, '')}`);
  if (channel) parts.push(`in:#${channel.replace(/^#/, '')}`);
  if (!text && !from && !channel) parts.push('from:me');

  // Slack's after:/before: are EXCLUSIVE day boundaries, so shift each by one
  // day to make --since/--until inclusive like every other connector
  // (e.g. --since 2026-06-10 must return messages from June 10 itself).
  const DAY_MS = 86_400_000;
  const after = toDateString(new Date(parseSince(sinceStr).getTime() - DAY_MS));
  parts.push(`after:${after}`);
  if (until) {
    const u = parseDateOnly(until);
    if (!u) throw usage(`--until must be YYYY-MM-DD, got "${until}"`);
    parts.push(`before:${toDateString(new Date(u.getTime() + DAY_MS))}`);
  }
  const query = parts.join(' ');

  const perToken = await Promise.all(
    tokens.map(async (t) => (await searchMessages(t.token, query)).map((m) => toEvent(m)))
  );
  return dedupe(perToken.flat());
}

/**
 * loom slack history --channel <name|id> [--since 7d] [--until YYYY-MM-DD]
 * Every message in one channel (bot/app posts included), exact time window.
 */
async function history(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);
  const tokens = collectTokens(flags);
  if (tokens.length === 0) {
    throw new Error(
      'No Slack token. Set SLACK_TOKEN (and/or SLACK_TOKEN_<NAME>) or pass --token.'
    );
  }
  const channelArg = typeof flags.channel === 'string' ? flags.channel : undefined;
  if (!channelArg) throw usage('history needs --channel <name|id>');

  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const until = typeof flags.until === 'string' ? flags.until : undefined;
  const oldest = String(parseSince(sinceStr).getTime() / 1000);
  let latest: string | undefined;
  if (until) {
    const u = parseDateOnly(until);
    if (!u) throw usage(`--until must be YYYY-MM-DD, got "${until}"`);
    latest = String((u.getTime() + 86_400_000) / 1000); // end of that day
  }

  // Find the workspace (token) that can see the channel.
  const isId = /^[CDG][A-Z0-9]{7,}$/.test(channelArg);
  const errors: string[] = [];
  for (const t of tokens) {
    let id = channelArg;
    let name = channelArg;
    try {
      if (!isId) {
        const c = await findChannel(t.token, channelArg);
        id = c.id;
        name = c.name;
      }
      const msgs = await channelHistory(t.token, id, oldest, latest);
      return msgs.map((m) => historyToEvent(m, id, name));
    } catch (err) {
      errors.push(`${t.label}: ${(err as Error).message}`);
    }
  }
  throw new Error(`slack history failed in every workspace:\n  ${errors.join('\n  ')}`);
}

function historyToEvent(m: SlackHistoryMessage, channelId: string, channelName: string): ActivityEvent {
  const seconds = parseFloat(m.ts);
  const text = extractText(m);
  return {
    timestamp: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : '',
    source: 'slack',
    type: 'message',
    ref: `${channelId}:${m.ts}`,
    title: `#${channelName}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    body: text || undefined,
    actor: m.username ?? m.user ?? m.bot_id,
    raw: m,
  };
}

/**
 * Best human-readable text of a raw message: plain text, else attachment
 * titles/text, else any text leaves inside Block Kit blocks (app posts often
 * carry their content only there).
 */
function extractText(m: Pick<SlackHistoryMessage, 'text' | 'attachments' | 'blocks'>): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (m.text && m.text.trim()) return clean(m.text);
  const att = (m.attachments ?? [])
    .map((a) => a.title || a.text || a.fallback)
    .filter(Boolean)
    .join(' — ');
  if (att) return clean(att);
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'text' && typeof v === 'string') parts.push(v);
        else walk(v);
      }
    }
  };
  walk(m.blocks ?? []);
  return clean(parts.join(' '));
}

function toEvent(m: SlackMatch): ActivityEvent {
  const channel =
    m.channel.is_im ? 'DM' : m.channel.is_mpim ? 'group DM' : m.channel.name ?? m.channel.id;
  const seconds = parseFloat(m.ts);
  const timestamp = Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : '';
  const text = extractText(m);

  return {
    timestamp,
    source: 'slack',
    type: 'message',
    ref: `${m.channel.id}:${m.ts}`,
    title: `#${channel}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
    body: text || undefined,
    actor: m.username,
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
    `slack: ${reason}\n` +
      'usage: loom slack messages [--since 7d] [--until DATE] [--channel C] [--from U|me] [--query "..."]\n' +
      '       loom slack history  --channel <name|id> [--since 7d] [--until DATE]'
  );
}
