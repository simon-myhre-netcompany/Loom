/**
 * GitHub connector — command handlers. Read-only.
 *
 *   loom github prs      [--since 7d] [--until YYYY-MM-DD]
 *   loom github commits  [--since 7d] [--until YYYY-MM-DD]
 *   loom github comments [--since 7d] [--until YYYY-MM-DD] [--all]
 *
 * Reads every GITHUB_TOKEN / GITHUB_TOKEN_* env var (one per resource owner,
 * e.g. personal + a work org), queries each, and merges/dedupes the results.
 */
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import {
  getLogin,
  searchAuthoredPRs,
  searchAuthoredCommits,
  searchCommentedIssues,
  listIssueComments,
  listReviewComments,
  listReviews,
  type GhPr,
  type GhCommit,
  type GhComment,
  type GhReview,
} from './client.js';

interface NamedToken {
  label: string;
  token: string;
}

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'prs':
      return collect(argv, prsForToken);
    case 'commits':
      return collect(argv, commitsForToken);
    case 'comments':
      return collect(argv, commentsForToken);
    case undefined:
      throw usage('missing action');
    default:
      throw usage(`unknown action "${action}"`);
  }
}

/** Run a per-token fetcher across all configured tokens, then merge + dedupe. */
async function collect(
  argv: string[],
  fetcher: (
    tok: NamedToken,
    from: string,
    to: string,
    flags: Record<string, string | boolean>
  ) => Promise<ActivityEvent[]>
): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);
  const tokens = collectTokens(flags);
  if (tokens.length === 0) {
    throw new Error(
      'No GitHub token. Set GITHUB_TOKEN (and/or GITHUB_TOKEN_<NAME> for more ' +
        'accounts/orgs) or pass --token. Run `loom guide github` for how to get one.'
    );
  }

  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to = typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  const perToken = await Promise.all(tokens.map((t) => fetcher(t, from, to, flags)));
  return dedupeByRefAndUrl(perToken.flat());
}

async function prsForToken(t: NamedToken, from: string, to: string): Promise<ActivityEvent[]> {
  const login = await getLogin(t.token);
  const prs = await searchAuthoredPRs(t.token, login, from, to);
  return prs.map(prToEvent);
}

async function commitsForToken(t: NamedToken, from: string, to: string): Promise<ActivityEvent[]> {
  const login = await getLogin(t.token);
  const commits = await searchAuthoredCommits(t.token, login, from, to);
  return commits.map(commitToEvent);
}

/**
 * Comments: search for issues/PRs the login commented on in the range, then
 * fetch each thread's conversation comments, inline review comments and review
 * verdicts. Default: only the login's own comments; --all keeps everyone's.
 */
async function commentsForToken(
  t: NamedToken,
  from: string,
  to: string,
  flags: Record<string, string | boolean>
): Promise<ActivityEvent[]> {
  const login = await getLogin(t.token);
  const all = flags.all === true;
  const issues = await searchCommentedIssues(t.token, login, from, to);
  const since = `${from}T00:00:00Z`;
  const toEnd = `${to}T23:59:59Z`;
  const inRange = (ts: string | null | undefined): ts is string =>
    !!ts && ts >= since && ts <= toEnd;
  const mine = (user: { login: string } | null): boolean => all || user?.login === login;

  const perIssue = await Promise.all(
    issues.map(async (issue) => {
      const repo = repoFromApiUrl(issue.repository_url);
      const isPr = !!issue.pull_request;
      const [conversation, inline, reviews] = await Promise.all([
        listIssueComments(t.token, repo, issue.number, since),
        isPr ? listReviewComments(t.token, repo, issue.number, since) : Promise.resolve([]),
        isPr ? listReviews(t.token, repo, issue.number) : Promise.resolve([]),
      ]);
      const events: ActivityEvent[] = [];
      for (const c of conversation)
        if (inRange(c.created_at) && mine(c.user))
          events.push(commentToEvent(c, repo, issue, 'comment'));
      for (const c of inline)
        if (inRange(c.created_at) && mine(c.user))
          events.push(commentToEvent(c, repo, issue, 'review_comment'));
      // Skip body-less COMMENTED reviews — GitHub auto-creates one per inline
      // comment batch, and the inline comments themselves are already events.
      for (const r of reviews)
        if (inRange(r.submitted_at) && mine(r.user) && !(r.state === 'COMMENTED' && !r.body))
          events.push(reviewToEvent(r, repo, issue));
      return events;
    })
  );
  return perIssue.flat();
}

function prToEvent(pr: GhPr): ActivityEvent {
  const repo = repoFromApiUrl(pr.repository_url);
  const merged = pr.pull_request?.merged_at;
  const state = merged ? 'merged' : pr.state;
  return {
    timestamp: pr.updated_at,
    source: 'github',
    type: 'pr',
    ref: `${repo}#${pr.number}`,
    title: `PR #${pr.number} (${state}): ${pr.title}`,
    url: pr.html_url,
    raw: pr,
  };
}

function commitToEvent(c: GhCommit): ActivityEvent {
  const message = c.commit.message ?? '';
  const firstLine = message.split('\n')[0];
  return {
    timestamp: c.commit.author?.date ?? '',
    source: 'github',
    type: 'commit',
    ref: `${c.repository.full_name}@${c.sha.slice(0, 7)}`,
    title: firstLine,
    body: message.includes('\n') ? message : undefined,
    url: c.html_url,
    raw: c,
  };
}

function commentToEvent(
  c: GhComment,
  repo: string,
  issue: GhPr,
  type: 'comment' | 'review_comment'
): ActivityEvent {
  const kind = issue.pull_request ? 'PR' : 'issue';
  const where =
    type === 'review_comment' && c.path
      ? `${c.path} in ${kind} ${repo}#${issue.number}`
      : `${kind} ${repo}#${issue.number}`;
  return {
    timestamp: c.created_at,
    source: 'github',
    type,
    ref: `${repo}#${issue.number}@comment-${c.id}`,
    title: `Comment on ${where}: ${issue.title}`,
    body: c.body || undefined,
    actor: c.user?.login,
    url: c.html_url,
    raw: c,
  };
}

function reviewToEvent(r: GhReview, repo: string, issue: GhPr): ActivityEvent {
  const verdict = r.state.toLowerCase().replace(/_/g, ' ');
  return {
    timestamp: r.submitted_at ?? '',
    source: 'github',
    type: 'review',
    ref: `${repo}#${issue.number}@review-${r.id}`,
    title: `Review (${verdict}) on PR ${repo}#${issue.number}: ${issue.title}`,
    body: r.body || undefined,
    actor: r.user?.login,
    url: r.html_url,
    raw: r,
  };
}

/** Collect tokens from --token, else every GITHUB_TOKEN[_*] env var. */
function collectTokens(flags: Record<string, string | boolean>): NamedToken[] {
  if (typeof flags.token === 'string') return [{ label: 'flag', token: flags.token }];
  const out: NamedToken[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (key === 'GITHUB_TOKEN') out.push({ label: 'default', token: value });
    else if (key.startsWith('GITHUB_TOKEN_'))
      out.push({ label: key.slice('GITHUB_TOKEN_'.length).toLowerCase(), token: value });
  }
  return out;
}

/** "https://api.github.com/repos/acme/foo" -> "acme/foo". */
function repoFromApiUrl(url: string): string {
  const m = url.match(/\/repos\/(.+)$/);
  return m ? m[1] : url;
}

function dedupeByRefAndUrl(events: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<string>();
  const out: ActivityEvent[] = [];
  for (const e of events) {
    const key = e.url ?? e.ref;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function usage(reason: string): Error {
  return new Error(
    `github: ${reason}\n` +
      'usage: loom github <prs|commits|comments> [--since 7d] [--until YYYY-MM-DD] [--all]'
  );
}
