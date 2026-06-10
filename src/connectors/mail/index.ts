/**
 * Mail connector — reads messages from Apple Mail via a JXA helper:
 * `sent` (what you sent) and `inbox` (what arrived). Read-only, local, no
 * tokens. Needs the macOS Automation permission (your terminal app allowed
 * to control Mail.app).
 *
 * macOS-only by decision: mail support is disabled on Ubuntu/Linux.
 *
 *   loom mail sent  [--since 7d] [--until YYYY-MM-DD]
 *   loom mail inbox [--since 7d] [--until YYYY-MM-DD]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';

const execFileAsync = promisify(execFile);

// Sibling helper.js — original in src/ (tsx) or the copy in dist/ (built).
const HELPER = fileURLToPath(new URL('./helper.js', import.meta.url));

interface RawMail {
  id: string;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  recipients: string[];
  /** dateSent for sent mail, dateReceived for inbox mail. */
  date: string;
}

type Box = 'sent' | 'inbox';

/** Is this connector usable right now on this machine? (for `loom status`) */
export function availability(): { state: 'ready' | 'unconfigured' | 'disabled'; detail: string } {
  if (process.platform !== 'darwin') {
    return { state: 'disabled', detail: 'macOS-only (reads Apple Mail) — disabled on this platform' };
  }
  if (!existsSync(HELPER)) {
    return { state: 'unconfigured', detail: 'helper missing — run `npm run build`' };
  }
  return { state: 'ready', detail: 'Apple Mail via Mail.app' };
}

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'sent':
    case undefined:
      return messages('sent', argv);
    case 'inbox':
      return messages('inbox', argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function messages(box: Box, argv: string[]): Promise<ActivityEvent[]> {
  const flags = parseFlags(argv);
  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to = typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  if (process.platform !== 'darwin') {
    throw new Error(
      'mail: disabled on this platform — the mail connector is macOS-only ' +
        '(reads Apple Mail). Run it on the Mac; the other sources work here.'
    );
  }
  if (!existsSync(HELPER)) {
    throw new Error('Mail helper not found. Run `npm run build`, or check src/connectors/mail/helper.js.');
  }

  let stdout: string;
  try {
    const res = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', HELPER, '--from', from, '--to', to, '--box', box],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    stdout = res.stdout;
  } catch (err) {
    const e = err as { stderr?: string };
    const msg = e.stderr ?? (err as Error).message;
    if (/not authorized|Not authorised|-1743|permission/i.test(msg)) {
      throw new Error(
        'Mail automation not permitted. Open System Settings → Privacy & Security → ' +
          'Automation and allow your terminal app to control Mail, then retry. ' +
          'See `loom guide mail`.'
      );
    }
    throw new Error(`mail helper failed: ${msg.trim()}`);
  }

  const raw = JSON.parse(stdout || '[]') as RawMail[];
  return raw.map((m) => toEvent(m, box)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function toEvent(m: RawMail, box: Box): ActivityEvent {
  const to = m.recipients.length
    ? `${m.recipients[0]}${m.recipients.length > 1 ? ` +${m.recipients.length - 1}` : ''}`
    : '(no recipient)';
  const title =
    box === 'inbox'
      ? `📥 ${m.subject || '(no subject)'} ← ${m.sender || '(unknown sender)'}${m.account ? ` [${m.account}]` : ''}`
      : `✉️ ${m.subject || '(no subject)'} → ${to}${m.account ? ` [${m.account}]` : ''}`;
  return {
    timestamp: m.date,
    source: 'mail',
    type: box === 'inbox' ? 'email-received' : 'email',
    ref: m.id || `${m.account}:${m.date}`,
    title,
    body: m.recipients.length ? `to: ${m.recipients.join(', ')}` : undefined,
    actor: box === 'inbox' ? m.sender || undefined : undefined,
    // message:// opens it in Mail.app; id is the RFC Message-ID.
    url: m.id ? `message://%3c${encodeURIComponent(m.id)}%3e` : undefined,
    raw: m,
  };
}

function usage(reason: string): Error {
  return new Error(
    `mail: ${reason}\nusage: loom mail <sent|inbox> [--since 7d] [--until YYYY-MM-DD]`
  );
}
