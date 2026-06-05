/**
 * The normalized activity event — the core contract of Logger.
 *
 * Every connector, regardless of source, emits an array of these. The `logg`
 * skill merges events from all sources into a single timeline and reasons over
 * it. Keep this shape stable; add fields rather than renaming.
 */
export interface ActivityEvent {
  /** ISO-8601 timestamp of when the thing happened. */
  timestamp: string;
  /** Which connector produced this event. */
  source: Source;
  /** Source-specific kind, e.g. "worklog" | "commit" | "comment" | "meeting". */
  type: string;
  /** Stable identifier: issue key, commit sha, event id, worklog id, ... */
  ref: string;
  /** One-line human summary. */
  title: string;
  /** Optional fuller text (comment body, commit message, description). */
  body?: string;
  /** Optional deep link back to the source. */
  url?: string;
  /** Optional original payload, for power use / debugging. */
  raw?: unknown;
}

export type Source =
  | 'tempo'
  | 'jira'
  | 'git'
  | 'github'
  | 'calendar'
  | 'confluence'
  | 'slack'
  | 'teams'
  | 'timereg';
