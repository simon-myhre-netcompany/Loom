/**
 * Time helpers for `--since` / `--until` flags.
 */

/**
 * Parse a relative duration like "7d", "24h", "2w" into a Date in the past,
 * or an absolute "YYYY-MM-DD" into that date. `now` is injectable for testing.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  const abs = parseDateOnly(value);
  if (abs) return abs;

  const m = value.match(/^(\d+)\s*([hdw])$/i);
  if (!m) {
    throw new Error(
      `Could not parse time "${value}". Use e.g. "7d", "24h", "2w", or "YYYY-MM-DD".`
    );
  }
  const amount = parseInt(m[1], 10);
  const unitMs = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase()]!;
  return new Date(now.getTime() - amount * unitMs);
}

/** Parse a strict "YYYY-MM-DD" string, or null if it isn't one. */
export function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a Date as "YYYY-MM-DD" in local time. */
export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
