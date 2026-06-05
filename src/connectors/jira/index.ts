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
import { searchIssues, DEFAULT_JIRA_BASE, type JiraIssue } from './client.js';

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
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function issues(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const base = flagOrEnv(flags, 'base', 'JIRA_BASE_URL', DEFAULT_JIRA_BASE)!;
  const email = flagOrEnv(flags, 'email', 'JIRA_EMAIL');
  const token = flagOrEnv(flags, 'token', 'JIRA_API_TOKEN');
  if (!email || !token) {
    throw new Error(
      'Missing Jira credentials. Set JIRA_EMAIL and JIRA_API_TOKEN (and optionally ' +
        'JIRA_BASE_URL). Run `logger guide jira` for how to get them.'
    );
  }

  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));

  const jql =
    typeof flags.jql === 'string'
      ? flags.jql
      : `(assignee = currentUser() OR worklogAuthor = currentUser()) ` +
        `AND updated >= "${from}" ORDER BY updated DESC`;

  const raw = await searchIssues({ base, email, token, jql, fields: FIELDS });
  return raw.map((i) => toEvent(i, base));
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
      'usage: logger jira issues [--since 7d] [--until YYYY-MM-DD] [--jql "..."]'
  );
}
