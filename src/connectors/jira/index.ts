/**
 * Jira connector — command handlers. Read-only.
 *
 *   loom jira issues [--since 7d] [--until YYYY-MM-DD] [--jql "..."]
 *
 * Default scope: issues you're assigned to or have logged work on, updated in
 * the range. Override entirely with --jql.
 */
import { stderr, stdin, stdout } from 'node:process';
import type { ActivityEvent } from '../../types.js';
import { flagOrEnv, parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';
import { resolveAtlassianAuth, requireJiraBase } from '../../util/atlassian.js';
import { confirm } from '../../interactive.js';
import {
  searchIssues,
  getComments,
  getMyAccountId,
  getIssueDetail,
  findUser,
  getPriorities,
  addComment,
  getTransitions,
  transitionIssue,
  updateIssueFields,
  type JiraIssue,
  type JiraComment,
  type JiraTransition,
  type TransitionFieldMeta,
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
    // --- write actions (guarded) -------------------------------------------
    case 'comment':
      return comment(argv);
    case 'transition':
    case 'status':
      return transition(argv);
    case 'describe':
    case 'description':
      return describe(argv);
    case 'estimate':
      return estimate(argv);
    case 'assign':
      return assign(argv);
    case 'rename':
      return rename(argv);
    case 'labels':
      return labels(argv);
    case 'set':
      return set(argv);
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
  const base = requireJiraBase(flags);
  const auth = resolveAtlassianAuth(flags);
  if (!auth) {
    throw new Error(
      'Missing Atlassian credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN ' +
        '(plus JIRA_BASE_URL). Run `loom guide jira` for how to get them.'
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

  // --all: include comments from everyone (not just you) and, when you've named
  // a specific --key, the whole thread regardless of date.
  const all = flags.all === true || flags.all === 'true';

  // Which issues to scan: explicit --key, custom --jql, or your recent issues.
  let keys: string[];
  if (typeof flags.key === 'string') {
    keys = flags.key.split(',').map((k) => k.trim()).filter(Boolean);
  } else {
    const jql = typeof flags.jql === 'string' ? flags.jql : involvedJql(from);
    const found = await searchIssues({ base, email, token, jql, fields: ['key'] });
    keys = found.map((i) => i.key);
  }

  // Only resolve "me" when we actually filter by author.
  const me = all ? undefined : await getMyAccountId(base, email, token);
  // A named --key in --all mode means "give me the full thread" — skip the range.
  const wholeThread = all && typeof flags.key === 'string';
  const fromMs = new Date(`${from}T00:00:00`).getTime();
  const untilMs = new Date(`${until}T23:59:59`).getTime();

  // Fetch each issue's comments concurrently, then filter by author/range.
  const perIssue = await Promise.all(
    keys.map(async (key) => {
      const cs = await getComments(base, email, token, key);
      return cs
        .filter((c) => (me === undefined ? true : c.author?.accountId === me))
        .filter((c) => wholeThread || inRange(c.created, fromMs, untilMs))
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

// ===========================================================================
// Write actions. Every one is guarded the same way as `tempo log`:
//   1. needs Atlassian credentials (resolved by context()),
//   2. acts ONLY as the authenticated user — there is no impersonation param,
//      so we can never write on someone else's behalf,
//   3. previews the change and confirms before doing it (skip with --yes,
//      preview-only with --dry-run).
// Human-facing preview/success text goes to stderr so stdout stays clean JSON.
// ===========================================================================

/** loom jira comment --key K --body "..." [--dry-run] [--yes] */
async function comment(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'comment');
  const body = requireStr(flags, 'body', 'comment: --body "..." is required');

  const detail = await getIssueDetail(base, email, token, key);
  const plan = [`About to comment on ${key} — ${detail.summary ?? ''}`.trimEnd(), indent(body)].join(
    '\n'
  );

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [commentToEvent({ id: '(preview)', body, created: '' }, key, base)];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  const created = await addComment(base, email, token, key, body);
  stderr.write(`✅ Commented on ${key}.\n`);
  return [commentToEvent(created, key, base)];
}

/**
 * loom jira transition --key K --to "In Progress" [--dry-run] [--yes]
 *   [--field "Name=value" ...] [--resolution "Fixed"]
 *
 * Some transition screens require extra fields (e.g. Resolution and
 * Løsningsmetode when resolving). `--field` sets any field on the target
 * transition's screen, by display name or field id, and may repeat.
 * `--resolution X` is shorthand for `--field resolution=X`.
 */
async function transition(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'transition');
  const to = requireStr(
    flags,
    'to',
    'transition: --to "<status>" is required (e.g. --to "In Progress")'
  );

  // --field may repeat; parseFlags keeps only the last value, so scan argv.
  const fieldArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--field' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
      fieldArgs.push(argv[++i]);
    }
  }
  if (typeof flags.resolution === 'string') fieldArgs.push(`resolution=${flags.resolution}`);

  const [detail, transitions] = await Promise.all([
    getIssueDetail(base, email, token, key),
    getTransitions(base, email, token, key),
  ]);
  const target = transitions.find((t) => eqi(t.name, to) || eqi(t.to?.name, to));
  if (!target) {
    const available = transitions
      .map((t) => (t.to?.name && !eqi(t.to.name, t.name) ? `"${t.name}" → ${t.to.name}` : `"${t.name}"`))
      .join(', ');
    throw new Error(
      `No transition matching "${to}" from status "${detail.status ?? '?'}" on ${key}. ` +
        `Available: ${available || '(none — you may lack permission)'}.`
    );
  }
  const newStatus = target.to?.name ?? target.name;

  const fields = buildTransitionFields(fieldArgs, target, key);
  const fieldLines = Object.entries(fields).map(
    ([fid, v]) =>
      `  setting ${target.fields?.[fid]?.name ?? fid} = ${typeof v === 'object' && v !== null ? ((v as Record<string, string>).name ?? (v as Record<string, string>).value) : String(v)}`
  );
  const plan = [
    `About to move ${key} (${detail.summary ?? ''}) ` +
      `from "${detail.status ?? '?'}" to "${newStatus}" (transition "${target.name}").`,
    ...fieldLines,
  ].join('\n');

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [statusEvent(key, detail.status, newStatus, base)];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await transitionIssue(base, email, token, key, target.id, fields);
  stderr.write(`✅ ${key} → ${newStatus}.\n`);
  return [statusEvent(key, detail.status, newStatus, base)];
}

/**
 * Resolve "Name=value" pairs against the transition screen's field metadata:
 * match by display name or field id, and shape the value to what the field
 * type expects (resolution/option fields take an object, text takes a string).
 */
function buildTransitionFields(
  pairs: string[],
  target: JiraTransition,
  key: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const meta = target.fields ?? {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`transition: --field expects "Name=value", got "${pair}".`);
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const id = Object.keys(meta).find((fid) => eqi(fid, name) || eqi(meta[fid].name ?? '', name));
    if (!id) {
      const available = Object.entries(meta)
        .map(([fid, f]) => `"${f.name ?? fid}"`)
        .join(', ');
      throw new Error(
        `transition: field "${name}" is not on the "${target.name}" screen for ${key}. ` +
          `Available there: ${available || '(none)'}.`
      );
    }
    out[id] = shapeFieldValue(meta[id], name, value);
  }
  return out;
}

function shapeFieldValue(f: TransitionFieldMeta, name: string, value: string): unknown {
  if (f.allowedValues?.length) {
    const match = f.allowedValues.find((v) => eqi(v.value ?? v.name ?? '', value));
    if (!match) {
      const allowed = f.allowedValues.map((v) => v.value ?? v.name).join(', ');
      throw new Error(`transition: "${value}" is not allowed for ${name}. Allowed: ${allowed}.`);
    }
    // Resolutions/selects are set by object; prefer the key the value came from.
    return match.value !== undefined ? { value: match.value } : { name: match.name };
  }
  if (f.schema?.type === 'number') {
    const n = Number(value);
    if (isNaN(n)) throw new Error(`transition: ${name} expects a number, got "${value}".`);
    return n;
  }
  return value;
}

/** loom jira describe --key K --body "..." [--dry-run] [--yes] */
async function describe(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'describe');
  const body = requireStr(flags, 'body', 'describe: --body "..." is required (the new description)');

  const detail = await getIssueDetail(base, email, token, key);
  const plan = [
    `About to replace the description of ${key} (${detail.summary ?? ''}):`.trimEnd(),
    `  current: ${preview(detail.description)}`,
    `  new:     ${preview(body)}`,
  ].join('\n');

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [updateEvent(key, 'description', detail.summary, base, body)];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await updateIssueFields(base, email, token, key, { description: body });
  stderr.write(`✅ Updated description of ${key}.\n`);
  return [updateEvent(key, 'description', detail.summary, base, body)];
}

/** loom jira estimate --key K [--original 3h] [--remaining 2h] [--dry-run] [--yes] */
async function estimate(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'estimate');
  const original = optStr(flags, 'original');
  const remaining = optStr(flags, 'remaining');
  if (!original && !remaining) {
    throw usage('estimate: pass --original and/or --remaining (e.g. --original 3h --remaining 2h)');
  }
  for (const [name, v] of [['original', original], ['remaining', remaining]] as const) {
    if (v && !isJiraDuration(v)) {
      throw usage(`estimate: --${name} must be a Jira duration like "3h", "1d 4h", "30m"; got "${v}"`);
    }
  }

  const detail = await getIssueDetail(base, email, token, key);
  const timetracking: { originalEstimate?: string; remainingEstimate?: string } = {};
  if (original) timetracking.originalEstimate = original;
  if (remaining) timetracking.remainingEstimate = remaining;

  const lines = [`About to update time estimates on ${key} (${detail.summary ?? ''}):`.trimEnd()];
  if (original) lines.push(`  original:  ${detail.originalEstimate ?? '(none)'} → ${original}`);
  if (remaining) lines.push(`  remaining: ${detail.remainingEstimate ?? '(none)'} → ${remaining}`);
  const plan = lines.join('\n');

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [updateEvent(key, 'estimate', detail.summary, base, JSON.stringify(timetracking))];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await updateIssueFields(base, email, token, key, { timetracking });
  stderr.write(`✅ Updated estimates on ${key}.\n`);
  return [updateEvent(key, 'estimate', detail.summary, base, JSON.stringify(timetracking))];
}

/** loom jira assign --key K --to <name|email|me|none> [--dry-run] [--yes] */
async function assign(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'assign');
  const to = requireStr(flags, 'to', 'assign: --to <name|email|me|none> is required');

  const detail = await getIssueDetail(base, email, token, key);

  // Resolve the target: "me" → you, "none"/"unassigned" → clear, else look up.
  let accountId: string | null;
  let label: string;
  if (/^(none|unassigned|clear)$/i.test(to)) {
    accountId = null;
    label = '(unassigned)';
  } else if (/^me$/i.test(to)) {
    accountId = await getMyAccountId(base, email, token);
    label = 'me';
  } else {
    const user = await findUser(base, email, token, to);
    if (!user) throw new Error(`assign: no Jira user found matching "${to}".`);
    accountId = user.accountId;
    label = user.displayName ?? user.accountId;
  }

  const plan = `About to set assignee of ${key} (${detail.summary ?? ''}): ${detail.assignee ?? '(unassigned)'} → ${label}.`;
  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [updateEvent(key, 'assignee', detail.summary, base, label)];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await updateIssueFields(base, email, token, key, {
    assignee: accountId === null ? null : { accountId },
  });
  stderr.write(`✅ Assigned ${key} to ${label}.\n`);
  return [updateEvent(key, 'assignee', detail.summary, base, label)];
}

/** loom jira rename --key K --to "New summary" [--dry-run] [--yes] */
async function rename(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'rename');
  const to = requireStr(flags, 'to', 'rename: --to "<new summary>" is required');

  const detail = await getIssueDetail(base, email, token, key);
  const plan = [
    `About to rename ${key}:`,
    `  current: ${preview(detail.summary)}`,
    `  new:     ${preview(to)}`,
  ].join('\n');

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [updateEvent(key, 'summary', to, base, to)];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await updateIssueFields(base, email, token, key, { summary: to });
  stderr.write(`✅ Renamed ${key}.\n`);
  return [updateEvent(key, 'summary', to, base, to)];
}

/** loom jira labels --key K [--add x,y] [--remove z] [--dry-run] [--yes] */
async function labels(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'labels');
  const add = csv(flags.add);
  const remove = csv(flags.remove);
  if (!add.length && !remove.length) {
    throw usage('labels: pass --add x,y and/or --remove z');
  }

  const detail = await getIssueDetail(base, email, token, key);
  const current = detail.labels ?? [];
  const removeSet = new Set(remove);
  // Preserve order: keep current (minus removed), then append new ones.
  const next = [...current.filter((l) => !removeSet.has(l)), ...add.filter((l) => !current.includes(l))];

  const plan = [
    `About to update labels on ${key} (${detail.summary ?? ''}):`.trimEnd(),
    `  current: ${current.length ? current.join(', ') : '(none)'}`,
    `  new:     ${next.length ? next.join(', ') : '(none)'}`,
  ].join('\n');

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [updateEvent(key, 'labels', detail.summary, base, next.join(', '))];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await updateIssueFields(base, email, token, key, { labels: next });
  stderr.write(`✅ Updated labels on ${key}.\n`);
  return [updateEvent(key, 'labels', detail.summary, base, next.join(', '))];
}

/** loom jira set --key K [--priority High] [--due YYYY-MM-DD] [--dry-run] [--yes] */
async function set(argv: string[]): Promise<ActivityEvent[]> {
  const { base, email, token, flags } = context(argv);
  const key = requireKey(flags, 'set');
  const priority = optStr(flags, 'priority');
  const due = optStr(flags, 'due');
  if (!priority && !due) {
    throw usage('set: pass --priority <name> and/or --due YYYY-MM-DD');
  }
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw usage(`set: --due must be YYYY-MM-DD, got "${due}"`);
  }

  const detail = await getIssueDetail(base, email, token, key);
  const fields: Record<string, unknown> = {};
  if (priority) {
    // Validate up front — Jira's own error for a bad priority is cryptic.
    const valid = await getPriorities(base, email, token);
    const canonical = valid.find((p) => eqi(p, priority));
    if (!canonical) {
      throw usage(`set: unknown priority "${priority}". Valid: ${valid.join(', ')}.`);
    }
    fields.priority = { name: canonical };
  }
  if (due) fields.duedate = due;

  const lines = [`About to update ${key} (${detail.summary ?? ''}):`.trimEnd()];
  if (priority) lines.push(`  priority: ${detail.priority ?? '(none)'} → ${priority}`);
  if (due) lines.push(`  due:      ${detail.duedate ?? '(none)'} → ${due}`);
  const plan = lines.join('\n');

  if (flags['dry-run']) {
    stderr.write(plan + '\n(dry-run — nothing was changed.)\n');
    return [updateEvent(key, 'fields', detail.summary, base, JSON.stringify(fields))];
  }
  if (!(await confirmOrAbort(plan, flags))) return [];

  await updateIssueFields(base, email, token, key, fields);
  stderr.write(`✅ Updated ${key}.\n`);
  return [updateEvent(key, 'fields', detail.summary, base, JSON.stringify(fields))];
}

// --- write helpers ---------------------------------------------------------

/** A single issue key (writes target one issue at a time). */
function requireKey(flags: Record<string, string | boolean>, action: string): string {
  const k = typeof flags.key === 'string' ? flags.key.trim() : '';
  if (!k) throw usage(`${action}: --key <KEY> is required`);
  if (k.includes(',')) throw usage(`${action}: writes target one issue at a time (got "${k}")`);
  return k;
}

function requireStr(
  flags: Record<string, string | boolean>,
  name: string,
  message: string
): string {
  const v = typeof flags[name] === 'string' ? (flags[name] as string).trim() : '';
  if (!v) throw usage(message);
  return v;
}

function optStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = typeof flags[name] === 'string' ? (flags[name] as string).trim() : '';
  return v || undefined;
}

/** Parse a comma-separated flag value into a trimmed, de-duplicated list. */
function csv(value: string | boolean | undefined): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
}

function eqi(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Jira duration: one or more "<n><w|d|h|m>" units, space-separated. */
function isJiraDuration(s: string): boolean {
  return /^\d+[wdhm](\s+\d+[wdhm])*$/i.test(s.trim());
}

function preview(s: string | undefined): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '(empty)';
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

/**
 * Confirm a write, mirroring `tempo log`. With --yes, proceed silently. At a
 * TTY, print the plan and ask. Otherwise refuse rather than write blind.
 */
async function confirmOrAbort(
  plan: string,
  flags: Record<string, string | boolean>
): Promise<boolean> {
  if (flags.yes || flags.y) return true;
  if (!canPrompt(flags)) {
    throw new Error(
      'Refusing to write without confirmation. Re-run at a terminal to confirm ' +
        'interactively, pass --yes to skip the prompt, or --dry-run to preview.'
    );
  }
  stderr.write(plan + '\n');
  const ok = await confirm('Proceed?');
  if (!ok) stderr.write('Aborted — nothing was changed.\n');
  return ok;
}

/** Whether we can ask for interactive confirmation (mirrors cli's isInteractive). */
function canPrompt(flags: Record<string, string | boolean>): boolean {
  if (flags['no-interactive']) return false;
  if (flags.interactive || flags.i) return true;
  return !!(stdin.isTTY && stdout.isTTY);
}

function statusEvent(
  key: string,
  from: string | undefined,
  to: string,
  base: string
): ActivityEvent {
  return {
    timestamp: '',
    source: 'jira',
    type: 'transition',
    ref: key,
    title: `${key} status: ${from ?? '?'} → ${to}`,
    url: `${base}/browse/${key}`,
    raw: { key, from, to },
  };
}

function updateEvent(
  key: string,
  field: string,
  summary: string | undefined,
  base: string,
  value: string
): ActivityEvent {
  return {
    timestamp: '',
    source: 'jira',
    type: `update-${field}`,
    ref: key,
    title: `${key} ${field} updated${summary ? `: ${summary}` : ''}`,
    body: value,
    url: `${base}/browse/${key}`,
    raw: { key, field, value },
  };
}

function commentToEvent(c: JiraComment, key: string, base: string): ActivityEvent {
  const text = (c.body ?? '').trim();
  const tilKunde = /#TIL[_ ]?KUNDE/i.test(text);
  // Summarize with the first meaningful line (skip a lone #TIL_KUNDE marker).
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const summary = lines.find((l) => !/^#TIL[_ ]?KUNDE$/i.test(l)) ?? lines[0] ?? '';
  const author = c.author?.displayName;
  return {
    timestamp: c.created ?? '',
    source: 'jira',
    // Tag (don't filter) customer-facing comments so the skill can spot them.
    type: tilKunde ? 'comment-til-kunde' : 'comment',
    ref: key,
    title: `${key} comment${author ? ` by ${author}` : ''}${tilKunde ? ' #TIL_KUNDE' : ''}: ${summary.slice(0, 70)}`,
    body: text || undefined,
    actor: author,
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
      'usage:\n' +
      '  read:\n' +
      '    loom jira issues   [--since 7d] [--until DATE] [--jql "..."]\n' +
      '    loom jira comments [--key ABC-1,ABC-2] [--all] [--since 7d]\n' +
      '  write (all guarded — confirm, or --dry-run / --yes):\n' +
      '    loom jira comment    --key K --body "..."\n' +
      '    loom jira transition --key K --to "In Progress"\n' +
      '    loom jira describe   --key K --body "..."\n' +
      '    loom jira estimate   --key K [--original 3h] [--remaining 2h]\n' +
      '    loom jira assign     --key K --to <name|email|me|none>\n' +
      '    loom jira rename     --key K --to "New summary"\n' +
      '    loom jira labels     --key K [--add x,y] [--remove z]\n' +
      '    loom jira set        --key K [--priority High] [--due YYYY-MM-DD]'
  );
}
