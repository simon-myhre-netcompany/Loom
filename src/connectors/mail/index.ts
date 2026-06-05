/**
 * Mail connector — reads SENT messages from Apple Mail via a JXA helper.
 * Read-only, local, no tokens. Needs the macOS Automation permission (your
 * terminal app allowed to control Mail.app).
 *
 *   logger mail sent [--since 7d] [--until YYYY-MM-DD]
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
  dateSent: string;
}

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'sent':
    case undefined:
      return sent(argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function sent(argv: string[]): Promise<ActivityEvent[]> {
  if (process.platform !== 'darwin') {
    throw new Error('mail connector requires macOS (Apple Mail via JXA).');
  }
  if (!existsSync(HELPER)) {
    throw new Error('Mail helper not found. Run `npm run build`, or check src/connectors/mail/helper.js.');
  }

  const flags = parseFlags(argv);
  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to = typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  let stdout: string;
  try {
    const res = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', HELPER, '--from', from, '--to', to],
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
          'See `logger guide mail`.'
      );
    }
    throw new Error(`mail helper failed: ${msg.trim()}`);
  }

  const raw = JSON.parse(stdout || '[]') as RawMail[];
  return raw.map(toEvent).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function toEvent(m: RawMail): ActivityEvent {
  const to = m.recipients.length
    ? `${m.recipients[0]}${m.recipients.length > 1 ? ` +${m.recipients.length - 1}` : ''}`
    : '(no recipient)';
  return {
    timestamp: m.dateSent,
    source: 'mail',
    type: 'email',
    ref: m.id || `${m.account}:${m.dateSent}`,
    title: `✉️ ${m.subject || '(no subject)'} → ${to}${m.account ? ` [${m.account}]` : ''}`,
    body: m.recipients.length ? `to: ${m.recipients.join(', ')}` : undefined,
    // message:// opens it in Mail.app; id is the RFC Message-ID.
    url: m.id ? `message://%3c${encodeURIComponent(m.id)}%3e` : undefined,
    raw: m,
  };
}

function usage(reason: string): Error {
  return new Error(`mail: ${reason}\nusage: logger mail sent [--since 7d] [--until YYYY-MM-DD]`);
}
