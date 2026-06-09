/**
 * Tempo connector — command handlers.
 *
 *   loom tempo worklogs [--since 7d] [--until YYYY-MM-DD] [--user <accountId>]
 *   loom tempo log --issue TIL-123 --hours 1.5 [--date YYYY-MM-DD]
 *                    [--start HH:mm] [--description "..."] [--dry-run] [--yes]
 *
 * `log` is the one write path. It refuses to run without an account id (env
 * TEMPO_ACCOUNT_ID or --user) so we only ever create worklogs under that author.
 */
import { stderr, stdin, stdout } from 'node:process';
import type { ActivityEvent } from '../../types.js';
import { flagOrEnv, parseFlags } from '../../util/args.js';
import { parseSince, parseDateOnly, toDateString } from '../../util/time.js';
import { resolveAtlassianAuth } from '../../util/atlassian.js';
import {
  getIssueRef,
  getIssueFieldValue,
  updateIssueFields,
  DEFAULT_JIRA_BASE,
} from '../jira/client.js';
import { confirm } from '../../interactive.js';
import {
  createWorklog,
  getWorklogs,
  getAccounts,
  type TempoWorklog,
  type TempoAccount,
} from './client.js';

/**
 * The Jira custom field holding the Tempo Account (billing bucket). This is a
 * per-instance Tempo (Forge) field; override with --account-field or the
 * JIRA_ACCOUNT_FIELD env var if your instance differs.
 */
const DEFAULT_ACCOUNT_FIELD = 'customfield_10039';

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'worklogs':
      return worklogs(argv);
    case 'log':
      return log(argv);
    case 'accounts':
      return accounts(argv);
    case 'set-account':
      return setAccount(argv);
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
      'No Tempo token. Set TEMPO_API_TOKEN or pass --token. ' +
        'Run `loom guide tempo` for how to get one.'
    );
  }
  // Optional: scope to one user. Without it we get everything the token sees.
  const accountId = flagOrEnv(flags, 'user', 'TEMPO_ACCOUNT_ID');

  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to =
    typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  const raw = await getWorklogs({ token, accountId, from, to });
  return raw.map(toEvent);
}

/**
 * Create a worklog. Write path — guarded three ways:
 *   1. needs a token (TEMPO_API_TOKEN with worklog write scope),
 *   2. needs an explicit account id (TEMPO_ACCOUNT_ID / --user) — we never
 *      create under an account we weren't told to,
 *   3. confirms before posting (skip with --yes; preview with --dry-run).
 */
async function log(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const token = flagOrEnv(flags, 'token', 'TEMPO_API_TOKEN');
  if (!token) {
    throw new Error(
      'No Tempo token. Set TEMPO_API_TOKEN or pass --token. ' +
        'Run `loom guide tempo` for how to get one (with worklog write scope).'
    );
  }

  // Guard: never write without knowing whose worklog this is.
  const accountId = flagOrEnv(flags, 'user', 'TEMPO_ACCOUNT_ID');
  if (!accountId) {
    throw new Error(
      'Refusing to create a worklog without an account id — otherwise we might ' +
        'write under the wrong person. Set TEMPO_ACCOUNT_ID in .env (or pass ' +
        '--user <accountId>). Run `loom guide tempo` for how to find it.'
    );
  }

  const issueArg = typeof flags.issue === 'string' ? flags.issue.trim() : '';
  if (!issueArg) throw usage('log: --issue <KEY|id> is required');

  const hoursArg = typeof flags.hours === 'string' ? flags.hours : '';
  const hours = Number(hoursArg);
  if (!hoursArg || !Number.isFinite(hours) || hours <= 0) {
    throw usage(`log: --hours must be a positive number, got "${hoursArg || '(missing)'}"`);
  }
  const timeSpentSeconds = Math.round(hours * 3600);

  const startDate = resolveDate(flags.date);
  const startTime = resolveTime(flags.start);

  // Resolve the issue: a bare number is already the id Tempo wants; anything
  // else is a Jira key we look up (needs Atlassian creds). Carry the summary so
  // it can stand in as the description when none was given.
  const { issueId, issueLabel, summary } = await resolveIssue(issueArg, flags);
  const descriptionArg = typeof flags.description === 'string' ? flags.description.trim() : '';
  const description = descriptionArg || summary || '';

  const planText = [
    'About to create a Tempo worklog:',
    `  issue:       ${issueLabel} (id ${issueId})`,
    `  date:        ${startDate} ${startTime}`,
    `  time:        ${hours}h (${timeSpentSeconds}s)`,
    `  author:      ${accountId}`,
    `  description: ${description || '(none)'}`,
  ].join('\n');

  if (flags['dry-run']) {
    stderr.write(planText + '\n(dry-run — nothing was posted.)\n');
    // Return the planned worklog so `--json --dry-run` previews the payload.
    return [
      toEvent({
        issue: { id: issueId },
        timeSpentSeconds,
        startDate,
        startTime,
        description: description || undefined,
      }),
    ];
  }

  if (!(flags.yes || flags.y)) {
    if (!canPrompt(flags)) {
      throw new Error(
        'Refusing to create a worklog without confirmation. Re-run at a terminal ' +
          'to confirm interactively, pass --yes to skip the prompt, or --dry-run to preview.'
      );
    }
    stderr.write(planText + '\n');
    const ok = await confirm('Create it?');
    if (!ok) {
      stderr.write('Aborted — no worklog created.\n');
      return [];
    }
  }

  const created = await createWorklog({
    token,
    authorAccountId: accountId,
    issueId,
    timeSpentSeconds,
    startDate,
    startTime,
    description,
  });
  stdout.write(`✅ Created worklog ${created.tempoWorklogId ?? ''} on ${issueLabel}.\n`);
  return [toEvent(created)];
}

/**
 * List Tempo accounts (read). Default to OPEN only; --all includes every
 * status; --search filters by key/name substring.
 *
 *   loom tempo accounts [--search foo] [--all]
 */
async function accounts(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);
  const token = flagOrEnv(flags, 'token', 'TEMPO_API_TOKEN');
  if (!token) {
    throw new Error(
      'No Tempo token. Set TEMPO_API_TOKEN or pass --token. Run `loom guide tempo`.'
    );
  }
  const search = typeof flags.search === 'string' ? flags.search.toLowerCase() : '';
  let list = await getAccounts(token);
  if (!flags.all) list = list.filter((a) => (a.status ?? 'OPEN') === 'OPEN');
  if (search) list = list.filter((a) => `${a.key} ${a.name}`.toLowerCase().includes(search));
  return list.map(accountToEvent);
}

/**
 * Set (or clear) the Tempo Account on a Jira issue. Write path — guarded like
 * `log`: needs Atlassian creds to write the field, acts as the authenticated
 * user, and confirms first (--dry-run to preview, --yes to skip).
 *
 *   loom tempo set-account --issue KEY --account <key|id|none> [--dry-run] [--yes]
 */
async function setAccount(argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);

  const base = flagOrEnv(flags, 'base', 'JIRA_BASE_URL', DEFAULT_JIRA_BASE)!;
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      'Need Atlassian credentials to set the Account field on a Jira issue. ' +
        'Set ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN (see `loom guide jira`).'
    );
  }
  const issue = typeof flags.issue === 'string' ? flags.issue.trim() : '';
  if (!issue) throw usage('set-account: --issue <KEY> is required');
  if (issue.includes(',')) throw usage('set-account: one issue at a time');
  const accountArg =
    (typeof flags.account === 'string' ? flags.account.trim() : '') ||
    (typeof flags.to === 'string' ? flags.to.trim() : '');
  if (!accountArg) throw usage('set-account: --account <key|id|none> is required');

  const fieldId = flagOrEnv(flags, 'account-field', 'JIRA_ACCOUNT_FIELD', DEFAULT_ACCOUNT_FIELD)!;

  // Resolve the target account into the field value Jira stores ({ id } or null).
  let value: { id: number } | null;
  let label: string;
  if (/^(none|clear|unassigned|empty)$/i.test(accountArg)) {
    value = null;
    label = '(none)';
  } else if (/^\d+$/.test(accountArg)) {
    value = { id: Number(accountArg) };
    label = `account id ${accountArg}`;
  } else {
    const token = flagOrEnv(flags, 'token', 'TEMPO_API_TOKEN');
    if (!token) {
      throw new Error(
        `Need TEMPO_API_TOKEN to resolve account "${accountArg}" by key/name — ` +
          'or pass a numeric account id (see `loom tempo accounts`).'
      );
    }
    const match = resolveAccount(await getAccounts(token), accountArg);
    value = { id: match.id };
    label = `${match.key} — ${match.name} (id ${match.id})`;
  }

  // Current value, for the preview.
  const current = await getIssueFieldValue(base, auth.email, auth.token, issue, fieldId);
  const currentLabel = accountLabelOf(current);

  const plan = `About to set the Tempo Account on ${issue}: ${currentLabel} → ${label}.`;
  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [accountWriteEvent(issue, label, base)];
  }
  if (!(flags.yes || flags.y)) {
    if (!canPrompt(flags)) {
      throw new Error(
        'Refusing to set the Account without confirmation. Re-run at a terminal ' +
          'to confirm, pass --yes to skip the prompt, or --dry-run to preview.'
      );
    }
    stderr.write(plan + '\n');
    const ok = await confirm('Set it?');
    if (!ok) {
      stderr.write('Aborted — Account not changed.\n');
      return [];
    }
  }

  await updateIssueFields(base, auth.email, auth.token, issue, { [fieldId]: value });
  stderr.write(`✅ Set Account on ${issue} to ${label}.\n`);
  return [accountWriteEvent(issue, label, base)];
}

/** Match an account by exact key (case-insensitive), else a unique name substring. */
function resolveAccount(list: TempoAccount[], query: string): TempoAccount {
  const q = query.toLowerCase();
  const byKey = list.find((a) => a.key.toLowerCase() === q);
  if (byKey) return byKey;
  const byName = list.filter((a) => a.name.toLowerCase().includes(q) || a.key.toLowerCase().includes(q));
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) throw new Error(`set-account: no Tempo account matching "${query}".`);
  throw new Error(
    `set-account: "${query}" matches ${byName.length} accounts (e.g. ` +
      byName.slice(0, 5).map((a) => a.key).join(', ') +
      '). Use a more specific key, or the numeric id from `loom tempo accounts`.'
  );
}

/** Human label for a stored Account field value (the option Jira returns). */
function accountLabelOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '(none)';
  const v = value as { value?: string; optionProperties?: { key?: string; name?: string } };
  return v.optionProperties?.key ?? v.optionProperties?.name ?? v.value ?? '(set)';
}

function accountToEvent(a: TempoAccount): ActivityEvent {
  const meta = [
    a.customer?.name ? `customer: ${a.customer.name}` : '',
    a.category?.name ? `category: ${a.category.name}` : '',
    a.status && a.status !== 'OPEN' ? `status: ${a.status}` : '',
    `id: ${a.id}`,
  ].filter(Boolean);
  return {
    timestamp: '',
    source: 'tempo',
    type: 'account',
    ref: a.key,
    title: `${a.key} — ${a.name}`,
    body: meta.join(' · ') || undefined,
    raw: a,
  };
}

function accountWriteEvent(issue: string, label: string, base: string): ActivityEvent {
  return {
    timestamp: '',
    source: 'tempo',
    type: 'set-account',
    ref: issue,
    title: `${issue} Account → ${label}`,
    url: `${base}/browse/${issue}`,
    raw: { issue, account: label },
  };
}

/** A bare numeric arg is already the issue id; otherwise resolve the key via Jira. */
async function resolveIssue(
  issueArg: string,
  flags: Record<string, string | boolean>
): Promise<{ issueId: number; issueLabel: string; summary?: string }> {
  if (/^\d+$/.test(issueArg)) {
    return { issueId: Number(issueArg), issueLabel: `issue ${issueArg}` };
  }
  const base = flagOrEnv(flags, 'base', 'JIRA_BASE_URL', DEFAULT_JIRA_BASE)!;
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      `Need Atlassian credentials to resolve issue key "${issueArg}" to its numeric id. ` +
        'Set ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN (see `loom guide jira`), ' +
        'or pass the numeric id directly as --issue <number>.'
    );
  }
  try {
    const ref = await getIssueRef(base, auth.email, auth.token, issueArg);
    return { issueId: ref.id, issueLabel: ref.key, summary: ref.summary };
  } catch (err) {
    throw new Error(
      `Could not resolve issue "${issueArg}" via Jira: ${(err as Error).message}`
    );
  }
}

/** --date YYYY-MM-DD, default today. */
function resolveDate(flag: string | boolean | undefined): string {
  if (typeof flag !== 'string' || !flag) return toDateString(new Date());
  if (!parseDateOnly(flag)) throw usage(`log: --date must be YYYY-MM-DD, got "${flag}"`);
  return flag;
}

/** --start HH:mm or HH:mm:ss, default 09:00:00. */
function resolveTime(flag: string | boolean | undefined): string {
  if (typeof flag !== 'string' || !flag) return '09:00:00';
  const m = flag.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw usage(`log: --start must be HH:mm or HH:mm:ss, got "${flag}"`);
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
}

/** Whether we can ask for interactive confirmation (mirrors cli's isInteractive). */
function canPrompt(flags: Record<string, string | boolean>): boolean {
  if (flags['no-interactive']) return false;
  if (flags.interactive || flags.i) return true;
  return !!(stdin.isTTY && stdout.isTTY);
}

function toEvent(w: TempoWorklog): ActivityEvent {
  const hours = (w.timeSpentSeconds ?? 0) / 3600;
  const issueId = w.issue?.id;
  const ref = issueId != null ? `tempo-issue-${issueId}` : `worklog-${w.tempoWorklogId ?? 'unknown'}`;
  // Prefer the proper UTC instant; fall back to date+time, then created.
  const timestamp =
    w.startDateTimeUtc ??
    (w.startDate ? `${w.startDate}T${w.startTime ?? '00:00:00'}` : w.createdAt ?? '');

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
      'usage:\n' +
      '  loom tempo worklogs [--since 7d] [--until YYYY-MM-DD] [--user <accountId>]\n' +
      '  loom tempo accounts [--search <text>] [--all]\n' +
      '  loom tempo log --issue <KEY|id> --hours <n> [--date YYYY-MM-DD]\n' +
      '                   [--start HH:mm] [--description "..."] [--dry-run] [--yes]\n' +
      '  loom tempo set-account --issue <KEY> --account <key|id|none>\n' +
      '                   [--dry-run] [--yes]   (write — confirms first)'
  );
}
