/**
 * ICS calendar backend — the cross-platform alternative to the macOS EventKit
 * helper. Fetches one or more iCalendar (.ics) feeds (e.g. an Outlook/M365
 * "published calendar" link) and normalizes VEVENTs into ActivityEvents.
 *
 * Feeds come from env vars: CALENDAR_ICS_URL and/or CALENDAR_ICS_URL_<NAME>
 * (e.g. CALENDAR_ICS_URL_WORK). Values may be https URLs or local file paths.
 * NOTE: a published-calendar URL is a capability URL — anyone with it can read
 * the calendar. Treat it like a token: keep it in .env, never commit it.
 *
 * Stdlib only. Parses the common subset of RFC 5545 that real-world work
 * calendars use: VEVENT, TZID/UTC/all-day dates, and recurrence via RRULE
 * (DAILY / WEEKLY+BYDAY / MONTHLY / YEARLY with INTERVAL, UNTIL, COUNT),
 * EXDATE, and RECURRENCE-ID overrides.
 */
import { readFileSync } from 'node:fs';
import type { ActivityEvent } from '../../types.js';

// ---------------------------------------------------------------------------
// feed discovery + fetch
// ---------------------------------------------------------------------------

export interface IcsFeed {
  name: string;
  location: string; // https URL or local file path
}

/** All configured ICS feeds: CALENDAR_ICS_URL and CALENDAR_ICS_URL_* env vars. */
export function icsFeeds(env: NodeJS.ProcessEnv = process.env): IcsFeed[] {
  const feeds: IcsFeed[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key === 'CALENDAR_ICS_URL') feeds.push({ name: 'default', location: value });
    else if (key.startsWith('CALENDAR_ICS_URL_'))
      feeds.push({ name: key.slice('CALENDAR_ICS_URL_'.length).toLowerCase(), location: value });
  }
  return feeds;
}

async function fetchIcs(feed: IcsFeed): Promise<string> {
  if (/^https?:\/\//i.test(feed.location)) {
    let res: Response;
    try {
      res = await fetch(feed.location, { headers: { Accept: 'text/calendar, */*' } });
    } catch (err) {
      throw new Error(`calendar: network error fetching ICS feed "${feed.name}": ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(
        `calendar: ICS feed "${feed.name}" returned ${res.status} ${res.statusText}. ` +
          `Check the published-calendar URL (it may have been unpublished or rotated).`
      );
    }
    return res.text();
  }
  // Local file path — handy for tests and offline exports.
  try {
    return readFileSync(feed.location, 'utf8');
  } catch (err) {
    throw new Error(`calendar: cannot read ICS file "${feed.location}": ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// ICS parsing
// ---------------------------------------------------------------------------

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface VEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  url: string;
  organizer: string;
  attendees: number;
  status: string;
  allDay: boolean;
  start: Date;
  end: Date | null;
  rrule: string | null;
  exdates: Date[];
  recurrenceId: Date | null;
}

/** Unfold RFC 5545 folded lines and split into properties. */
function parseProps(text: string): IcsProp[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const props: IcsProp[] = [];
  for (const line of unfolded.split('\n')) {
    if (!line) continue;
    // NAME;PARAM=VAL;PARAM2="VAL2":value — find the first ':' outside quotes.
    let colon = -1;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ':' && !inQuotes) {
        colon = i;
        break;
      }
    }
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq === -1) continue;
      params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    props.push({ name: name.toUpperCase(), params, value });
  }
  return props;
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

// --- timezone handling -------------------------------------------------------

/** Windows timezone names (used by Outlook ICS) → IANA, common-for-us subset. */
const WINDOWS_TZ: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Oslo',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Warsaw',
  'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Etc/GMT',
  'UTC': 'Etc/UTC',
  'E. Europe Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Helsinki',
  'GTB Standard Time': 'Europe/Athens',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
};

function resolveTz(tzid: string | undefined): string | null {
  if (!tzid) return null;
  if (WINDOWS_TZ[tzid]) return WINDOWS_TZ[tzid];
  // IANA names contain a '/'; trust Intl to validate.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return tzid;
  } catch {
    return null;
  }
}

/** Convert wall-clock time in an IANA zone to a UTC Date (Intl-based, no deps). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  let utc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes converge across DST boundaries.
  for (let i = 0; i < 2; i++) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(new Date(utc))) {
      if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10);
    }
    const asIf = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
    const target = Date.UTC(y, mo - 1, d, h, mi, s);
    utc += target - asIf;
  }
  return new Date(utc);
}

/** Parse an ICS date/date-time value. Returns the Date and whether it was date-only. */
function parseIcsDate(value: string, params: Record<string, string>): { date: Date; dateOnly: boolean } | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, z] = m;
  const y = +ys, mo = +mos, d = +ds;
  if (params.VALUE === 'DATE' || hs === undefined) {
    // All-day: midnight local time, matching the EventKit helper's behaviour.
    return { date: new Date(y, mo - 1, d), dateOnly: true };
  }
  const h = +hs, mi = +mis, s = +ss;
  if (z) return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), dateOnly: false };
  const tz = resolveTz(params.TZID);
  if (tz) return { date: zonedToUtc(y, mo, d, h, mi, s, tz), dateOnly: false };
  // Floating or unknown TZID: interpret in the runtime's local zone.
  return { date: new Date(y, mo - 1, d, h, mi, s), dateOnly: false };
}

// --- VEVENT extraction --------------------------------------------------------

function parseVEvents(text: string): VEvent[] {
  const props = parseProps(text);
  const events: VEvent[] = [];
  let cur: IcsProp[] | null = null;
  let depth = 0; // VALARM etc. nest inside VEVENT
  for (const p of props) {
    if (p.name === 'BEGIN' && p.value === 'VEVENT' && cur === null) {
      cur = [];
      continue;
    }
    if (cur !== null) {
      if (p.name === 'BEGIN') depth++;
      else if (p.name === 'END' && depth > 0) depth--;
      else if (p.name === 'END' && p.value === 'VEVENT') {
        const ev = buildVEvent(cur);
        if (ev) events.push(ev);
        cur = null;
        continue;
      }
      if (depth === 0) cur.push(p);
    }
  }
  return events;
}

function buildVEvent(props: IcsProp[]): VEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const dtstart = get('DTSTART');
  if (!dtstart) return null;
  const start = parseIcsDate(dtstart.value, dtstart.params);
  if (!start) return null;

  const dtend = get('DTEND');
  const end = dtend ? parseIcsDate(dtend.value, dtend.params) : null;

  const exdates: Date[] = [];
  for (const p of props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const d = parseIcsDate(v.trim(), p.params);
      if (d) exdates.push(d.date);
    }
  }

  const recId = get('RECURRENCE-ID');
  const recurrenceId = recId ? parseIcsDate(recId.value, recId.params)?.date ?? null : null;

  const organizerProp = get('ORGANIZER');
  const organizer =
    organizerProp?.params.CN || organizerProp?.value.replace(/^mailto:/i, '') || '';

  return {
    uid: get('UID')?.value ?? '',
    summary: unescapeText(get('SUMMARY')?.value ?? ''),
    location: unescapeText(get('LOCATION')?.value ?? ''),
    description: unescapeText(get('DESCRIPTION')?.value ?? ''),
    url: get('URL')?.value ?? '',
    organizer,
    attendees: props.filter((p) => p.name === 'ATTENDEE').length,
    status: get('STATUS')?.value ?? '',
    allDay: start.dateOnly,
    start: start.date,
    end: end?.date ?? null,
    rrule: get('RRULE')?.value ?? null,
    exdates,
    recurrenceId,
  };
}

// ---------------------------------------------------------------------------
// recurrence expansion (pragmatic RRULE subset)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const BYDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_INSTANCES = 1000;

interface Rule {
  freq: string;
  interval: number;
  until: Date | null;
  count: number | null;
  byday: number[];
  bymonthday: number | null;
}

function parseRrule(rrule: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const kv of rrule.split(';')) {
    const eq = kv.indexOf('=');
    if (eq !== -1) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  const freq = parts.FREQ?.toUpperCase();
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const until = parts.UNTIL ? parseIcsDate(parts.UNTIL, {})?.date ?? null : null;
  const byday = (parts.BYDAY ?? '')
    .split(',')
    .map((d) => BYDAY_INDEX[d.trim().replace(/^[+-]?\d+/, '')])
    .filter((n): n is number => n !== undefined);
  return {
    freq,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1),
    until,
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
    byday,
    bymonthday: parts.BYMONTHDAY ? parseInt(parts.BYMONTHDAY.split(',')[0], 10) : null,
  };
}

/**
 * Expand a recurring event's start times within [from, to]. Keeps each
 * occurrence's wall-clock time by shifting the original start by whole
 * days/months (good enough across DST for meeting-length events).
 */
function expandRrule(ev: VEvent, rule: Rule, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const hardEnd = rule.until && rule.until < to ? rule.until : to;
  let produced = 0; // counts ALL occurrences (for COUNT), even before `from`

  const push = (d: Date) => {
    produced++;
    if (d >= from && d <= hardEnd && !ev.exdates.some((x) => x.getTime() === d.getTime())) {
      out.push(d);
    }
  };

  const start = ev.start;
  if (rule.freq === 'DAILY') {
    for (let i = 0; produced < (rule.count ?? MAX_INSTANCES) && i < MAX_INSTANCES; i++) {
      const d = new Date(start.getTime() + i * rule.interval * DAY_MS);
      if (d > hardEnd) break;
      push(d);
    }
  } else if (rule.freq === 'WEEKLY') {
    const days = (rule.byday.length ? rule.byday : [start.getDay()]).sort((a, b) => a - b);
    // Walk week by week from the start's week (Sunday-based, like getDay()).
    const weekStart = start.getTime() - start.getDay() * DAY_MS;
    outer: for (let w = 0; w < MAX_INSTANCES; w += rule.interval) {
      const base = weekStart + w * 7 * DAY_MS;
      if (base > hardEnd.getTime()) break;
      for (const day of days) {
        if (produced >= (rule.count ?? MAX_INSTANCES)) break outer;
        const d = new Date(base + day * DAY_MS);
        if (d < start || d > hardEnd) continue;
        push(d);
      }
    }
  } else if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
    const stepMonths = rule.freq === 'MONTHLY' ? rule.interval : 12 * rule.interval;
    const dayOfMonth = rule.bymonthday ?? start.getDate();
    for (let i = 0; produced < (rule.count ?? MAX_INSTANCES) && i < MAX_INSTANCES; i++) {
      const d = new Date(start);
      d.setMonth(start.getMonth() + i * stepMonths);
      d.setDate(dayOfMonth);
      if (d.getDate() !== dayOfMonth) continue; // month too short (e.g. 31st)
      if (d > hardEnd) break;
      if (d < start) continue;
      push(d);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// public entry: feeds → ActivityEvents in range
// ---------------------------------------------------------------------------

export async function icsEvents(from: Date, to: Date, feeds: IcsFeed[]): Promise<ActivityEvent[]> {
  const all: ActivityEvent[] = [];
  for (const feed of feeds) {
    const text = await fetchIcs(feed);
    const vevents = parseVEvents(text);

    // RECURRENCE-ID overrides replace the generated instance with that start.
    const overrides = new Map<string, VEvent>();
    for (const ev of vevents) {
      if (ev.recurrenceId && ev.uid) overrides.set(`${ev.uid}@${ev.recurrenceId.getTime()}`, ev);
    }

    for (const ev of vevents) {
      if (ev.recurrenceId) {
        // Modified instance of a series — include if it falls in range.
        if (ev.start >= from && ev.start <= to) all.push(toActivityEvent(ev, ev.start, feed));
        continue;
      }
      if (ev.rrule) {
        const rule = parseRrule(ev.rrule);
        if (rule) {
          for (const occStart of expandRrule(ev, rule, from, to)) {
            if (ev.uid && overrides.has(`${ev.uid}@${occStart.getTime()}`)) continue;
            all.push(toActivityEvent(ev, occStart, feed));
          }
          continue;
        }
        // Unparseable RRULE: fall through and at least keep the first instance.
      }
      if (ev.start >= from && ev.start <= to) all.push(toActivityEvent(ev, ev.start, feed));
    }
  }
  return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function toActivityEvent(ev: VEvent, occStart: Date, feed: IcsFeed): ActivityEvent {
  const bodyParts = [
    ev.location ? `📍 ${ev.location}` : '',
    ev.attendees ? `👥 ${ev.attendees} attendee(s)` : '',
    ev.description,
  ].filter(Boolean);

  return {
    timestamp: occStart.toISOString(),
    source: 'calendar',
    type: ev.allDay ? 'all-day' : 'meeting',
    ref: ev.uid ? `${ev.uid}@${occStart.toISOString()}` : `${feed.name}:${occStart.toISOString()}`,
    title: `${ev.summary || '(no title)'} [${feed.name}]`,
    body: bodyParts.length ? bodyParts.join('\n') : undefined,
    url: ev.url || undefined,
    raw: {
      uid: ev.uid,
      feed: feed.name,
      organizer: ev.organizer,
      status: ev.status,
      start: occStart.toISOString(),
      end: ev.end && !ev.rrule ? ev.end.toISOString() : undefined,
      recurring: !!ev.rrule,
    },
  };
}
