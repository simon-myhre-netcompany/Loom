/**
 * Calendar connector — reads Apple Calendar via a local EventKit helper binary.
 * Read-only, no network, no tokens. Just the macOS Calendar privacy permission.
 *
 *   loom calendar events [--since 7d] [--until YYYY-MM-DD]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, toDateString } from '../../util/time.js';

const execFileAsync = promisify(execFile);

// projectRoot/bin/calendar-helper — same depth from src/ (tsx) and dist/.
const HELPER = fileURLToPath(new URL('../../../bin/calendar-helper', import.meta.url));

interface RawEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  calendar: string;
  location: string;
  notes: string;
  url: string;
  organizer: string;
  attendees: string[];
  status: number;
}

export async function run(action: string | undefined, argv: string[]): Promise<ActivityEvent[]> {
  switch (action) {
    case 'events':
    case undefined: // default action
      return events(argv);
    default:
      throw usage(`unknown action "${action}"`);
  }
}

async function events(argv: string[]): Promise<ActivityEvent[]> {
  if (!existsSync(HELPER)) {
    throw new Error(
      `Calendar helper not built. Run \`npm run build\` on macOS (needs swiftc). ` +
        `Run \`loom guide calendar\` for setup.`
    );
  }

  const flags = parseFlags(argv);
  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to = typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  let stdout: string;
  try {
    const res = await execFileAsync(HELPER, ['--from', from, '--to', to], {
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    if (e.code === 77) {
      throw new Error(
        'Calendar access not granted. Open System Settings → Privacy & Security → ' +
          'Calendars and enable access for your terminal app, then retry. ' +
          'See `loom guide calendar`.'
      );
    }
    throw new Error(`calendar helper failed: ${e.stderr?.trim() || (err as Error).message}`);
  }

  const raw = JSON.parse(stdout) as RawEvent[];
  return raw.map(toEvent).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function toEvent(e: RawEvent): ActivityEvent {
  const bodyParts = [
    e.location ? `📍 ${e.location}` : '',
    e.attendees.length ? `👥 ${e.attendees.length} attendee(s)` : '',
    e.notes,
  ].filter(Boolean);

  return {
    timestamp: e.start,
    source: 'calendar',
    type: e.allDay ? 'all-day' : 'meeting',
    ref: e.id || `${e.calendar}:${e.start}`,
    title: `${e.title || '(no title)'}${e.calendar ? ` [${e.calendar}]` : ''}`,
    body: bodyParts.length ? bodyParts.join('\n') : undefined,
    url: e.url || undefined,
    raw: e,
  };
}

function usage(reason: string): Error {
  return new Error(
    `calendar: ${reason}\nusage: loom calendar events [--since 7d] [--until YYYY-MM-DD]`
  );
}
