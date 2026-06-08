/**
 * GitHub connector — command handlers. Read-only.
 *
 *   loom github prs     [--since 7d] [--until YYYY-MM-DD]
 *   loom github commits [--since 7d] [--until YYYY-MM-DD]
 *
 * Reads every GITHUB_TOKEN / GITHUB_TOKEN_* env var (one per resource owner,
 * e.g. personal + oslo-kommune), queries each, and merges/dedupes the results.
 */
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import {
  getLogin,
  searchAuthoredPRs,
  searchAuthoredCommits,
  type GhPr,
  type GhCommit,
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
    case undefined:
      throw usage('missing action');
    default:
      throw usage(`unknown action "${action}"`);
  }
}

/** Run a per-token fetcher across all configured tokens, then merge + dedupe. */
async function collect(
  argv: string[],
  fetcher: (tok: NamedToken, from: string, to: string) => Promise<ActivityEvent[]>
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

  const perToken = await Promise.all(tokens.map((t) => fetcher(t, from, to)));
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

/** "https://api.github.com/repos/oslo-kommune/foo" -> "oslo-kommune/foo". */
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
      'usage: loom github <prs|commits> [--since 7d] [--until YYYY-MM-DD]'
  );
}
