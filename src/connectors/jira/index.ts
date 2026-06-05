/**
 * Jira connector — command handlers. Read-only.
 *
 *   logger jira issues [--since 7d] [--until YYYY-MM-DD] [--jql "..."]
 *
 * Default scope: issues you're assigned to or have logged work on, updated in
 * the range. Override entirely with --jql.
 */
import type { ActivityEvent } from '../../types.js';
import { flagOrEnv, parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import { resolveAtlassianAuth } from '../../util/atlassian.js';
import {
  searchIssues,
  getComments,
  getMyAccountId,
  DEFAULT_JIRA_BASE,
  type JiraIssue,
  type JiraComment,
} from './client.js';

const FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'duedate',
  'created',
  'updated',
];

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'issues':
    case undefined:
      return issues(argv);
    case 'comments':
      return comments(argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

interface Ctx {
  base: string;
  email: string;
  token: string;
  from: string;
  until: string;
  flags: Record<string, string | boolean>;
}

/** Resolve base + credentials + date range shared by all actions. */
function context(argv: string[]): Ctx {
  const flags = parseFlags(argv);
  const base = flagOrEnv(flags, 'base', 'JIRA_BASE_URL', DEFAULT_JIRA_BASE)!;
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      'Missing Atlassian credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN ' +
        '(and optionally JIRA_BASE_URL). Run `logger guide jira` for how to get them.'
    );
  }
  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const until = typeof flags.until === 'string' ? flags.until : toDateString(new Date());
  return { base, email: auth.email, token: auth.token, from, until, flags };
}

/** Default JQL: issues you're assignee of or have logged work on, in range. */
function involvedJql(from: string): string {
  return (
    `(assignee = currentUser() OR worklogAuthor = currentUser()) ` +
    `AND updated >= "${from}" ORDER BY updated DESC`
  );
}

async function issues(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, from, flags } = context(argv);
  const jql = typeof flags.jql === 'string' ? flags.jql : involvedJql(from);
  const raw = await searchIssues({ base, email, token, jql, fields: FIELDS });
  return raw.map((i) => toEvent(i, base));
}

async function comments(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, from, until, flags } = context(argv);

  // Which issues to scan: explicit --key, custom --jql, or your recent issues.
  let keys: string[];
  if (typeof flags.key === 'string') {
    keys = flags.key.split(',').map((k) => k.trim()).filter(Boolean);
  } else {
    const jql = typeof flags.jql === 'string' ? flags.jql : involvedJql(from);
    const found = await searchIssues({ base, email, token, jql, fields: ['key'] });
    keys = found.map((i) => i.key);
  }

  const me = await getMyAccountId(base, email, token);
  const fromMs = new Date(`${from}T00:00:00`).getTime();
  const untilMs = new Date(`${until}T23:59:59`).getTime();

  // Fetch each issue's comments concurrently, keep only mine in the range.
  const perIssue = await Promise.all(
    keys.map(async (key) => {
      const cs = await getComments(base, email, token, key);
      return cs
        .filter((c) => c.author?.accountId === me && inRange(c.created, fromMs, untilMs))
        .map((c) => commentToEvent(c, key, base));
    })
  );
  return perIssue.flat().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function inRange(iso: string | undefined, fromMs: number, untilMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= fromMs && t <= untilMs;
}

function commentToEvent(c: JiraComment, key: string, base: string): ActivityEvent {
  const text = (c.body ?? '').trim();
  const tilKunde = /#TIL[_ ]?KUNDE/i.test(text);
  // Summarize with the first meaningful line (skip a lone #TIL_KUNDE marker).
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const summary = lines.find((l) => !/^#TIL[_ ]?KUNDE$/i.test(l)) ?? lines[0] ?? '';
  return {
    timestamp: c.created ?? '',
    source: 'jira',
    // Tag (don't filter) customer-facing comments so the skill can spot them.
    type: tilKunde ? 'comment-til-kunde' : 'comment',
    ref: key,
    title: `${key} comment${tilKunde ? ' #TIL_KUNDE' : ''}: ${summary.slice(0, 70)}`,
    body: text || undefined,
    url: `${base}/browse/${key}?focusedCommentId=${c.id}`,
    raw: c,
  };
}

function toEvent(issue: JiraIssue, base: string): ActivityEvent {
  const f = issue.fields;
  const status = f.status?.name ?? 'Unknown';
  const meta = [
    f.issuetype?.name,
    f.assignee?.displayName ? `assignee: ${f.assignee.displayName}` : 'unassigned',
    f.priority?.name ? `priority: ${f.priority.name}` : '',
    f.duedate ? `due: ${f.duedate}` : '',
  ].filter(Boolean);

  return {
    timestamp: f.updated ?? f.created ?? '',
    source: 'jira',
    type: 'issue',
    ref: issue.key,
    title: `${issue.key} [${status}]: ${f.summary ?? ''}`,
    body: meta.join(' · ') || undefined,
    url: `${base}/browse/${issue.key}`,
    raw: issue,
  };
}

function usage(reason: string): Error {
  return new Error(
    `jira: ${reason}\n` +
      'usage: logger jira <issues|comments> [--since 7d] [--until YYYY-MM-DD] [--jql "..."] [--key ABC-1,ABC-2]'
  );
}
