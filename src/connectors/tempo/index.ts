/**
 * Tempo connector — command handlers. Read-only.
 *
 *   logger tempo worklogs [--since 7d] [--until YYYY-MM-DD] [--user <accountId>]
 */
import type { ActivityEvent } from '../../types.js';
import { flagOrEnv, parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import { getWorklogs, type TempoWorklog } from './client.js';

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'worklogs':
      return worklogs(argv);
    case undefined:
      throw usage('missing action');
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function worklogs(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const token = flagOrEnv(flags, 'token', 'TEMPO_API_TOKEN');
  if (!token) {
    throw new Error(
      'No Tempo token. Set TEMPO_API_TOKEN (see .env.example) or pass --token.'
    );
  }
  const accountId = flagOrEnv(flags, 'user', 'TEMPO_ACCOUNT_ID');
  if (!accountId) {
    throw new Error(
      'No Tempo accountId. Set TEMPO_ACCOUNT_ID (see .env.example) or pass --user.'
    );
  }

  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to =
    typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  const raw = await getWorklogs({ token, accountId, from, to });
  return raw.map(toEvent);
}

function toEvent(w: TempoWorklog): ActivityEvent {
  const hours = (w.timeSpentSeconds ?? 0) / 3600;
  const issueId = w.issue?.id;
  const ref = issueId != null ? `tempo-issue-${issueId}` : `worklog-${w.tempoWorklogId ?? 'unknown'}`;
  const datePart = w.startDate ?? '';
  const timePart = w.startTime ?? '00:00:00';
  const timestamp = datePart ? `${datePart}T${timePart}` : new Date(w.createdAt ?? Date.now()).toISOString();

  return {
    timestamp,
    source: 'tempo',
    type: 'worklog',
    ref,
    title: `Logged ${roundHours(hours)}h${issueId != null ? ` on issue ${issueId}` : ''}`,
    body: w.description || undefined,
    // Tempo gives an API self-link, not a browse URL; the Jira connector will
    // later resolve issue id -> key for a proper /browse link.
    url: w.issue?.self,
    raw: w,
  };
}

function roundHours(h: number): number {
  return Math.round(h * 100) / 100;
}

function usage(reason: string): Error {
  return new Error(
    `tempo: ${reason}\n` +
      'usage: logger tempo worklogs [--since 7d] [--until YYYY-MM-DD] [--user <accountId>]'
  );
}
