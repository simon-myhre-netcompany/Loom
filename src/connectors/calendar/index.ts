/**
 * Calendar connector — two interchangeable backends behind one action:
 *
 *  - macOS: Apple Calendar via a local EventKit helper binary. Read-only,
 *    no network, no tokens. Just the macOS Calendar privacy permission.
 *  - Anywhere (Linux/containers): ICS feeds (e.g. an Outlook/M365 published
 *    calendar URL) via CALENDAR_ICS_URL / CALENDAR_ICS_URL_<NAME> env vars.
 *
 * Backend choice: EventKit when on macOS and the helper is built; otherwise
 * ICS feeds if configured. `--ics` forces the ICS backend on any platform.
 *
 *   loom calendar events [--since 7d] [--until YYYY-MM-DD] [--ics]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { ActivityEvent } from '../../types.js';
import { parseFlags } from '../../util/args.js';
import { parseSince, parseDateOnly, toDateString } from '../../util/time.js';
import { icsFeeds, icsEvents } from './ics.js';

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

/** Is this connector usable right now on this machine? (for `loom status`) */
export function availability(): { state: 'ready' | 'unconfigured' | 'disabled'; detail: string } {
  if (process.platform === 'darwin' && existsSync(HELPER)) {
    return { state: 'ready', detail: 'Apple Calendar via EventKit' };
  }
  const feeds = icsFeeds();
  if (feeds.length > 0) {
    return { state: 'ready', detail: `ICS feeds: ${feeds.map((f) => f.name).join(', ')}` };
  }
  return {
    state: 'unconfigured',
    detail:
      process.platform === 'darwin'
        ? 'run `npm run build` (EventKit helper) or set CALENDAR_ICS_URL'
        : 'set CALENDAR_ICS_URL (EventKit is macOS-only)',
  };
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
  const flags = parseFlags(argv);
  const sinceStr = typeof flags.since === 'string' ? flags.since : '7d';
  const from = toDateString(parseSince(sinceStr));
  const to = typeof flags.until === 'string' ? flags.until : toDateString(new Date());

  const feeds = icsFeeds();
  const eventKitAvailable = process.platform === 'darwin' && existsSync(HELPER);
  const forceIcs = !!flags.ics;

  if (forceIcs || !eventKitAvailable) {
    if (feeds.length > 0) {
      // End of the `to` day, so today's meetings are included.
      const fromDate = parseDateOnly(from)!;
      const toDate = new Date(parseDateOnly(to)!.getTime() + 86_400_000 - 1);
      return icsEvents(fromDate, toDate, feeds);
    }
    if (forceIcs) {
      throw new Error(
        'calendar: --ics given but no ICS feed configured. Set CALENDAR_ICS_URL ' +
          '(or CALENDAR_ICS_URL_<NAME>) in .env. See `loom guide calendar`.'
      );
    }
    throw new Error(
      process.platform === 'darwin'
        ? 'Calendar helper not built and no ICS feed configured. Run `npm run build` ' +
            '(needs swiftc), or set CALENDAR_ICS_URL in .env. See `loom guide calendar`.'
        : 'calendar: Apple Calendar (EventKit) is macOS-only. On this platform, set ' +
            'CALENDAR_ICS_URL (or CALENDAR_ICS_URL_<NAME>) in .env to a published ' +
            'calendar / .ics link instead. See `loom guide calendar`.'
    );
  }

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
    `calendar: ${reason}\nusage: loom calendar events [--since 7d] [--until YYYY-MM-DD] [--ics]`
  );
}
