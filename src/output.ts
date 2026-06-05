/**
 * Output rendering. Agents get machine-readable JSON; humans at a TTY get a
 * readable table. Mode is auto-detected but always overridable by flags.
 */
import type { ActivityEvent } from './types.js';
import type { CredentialStatus } from './credentials.js';
import type { ConnectorSpec } from './registry.js';

export type OutputMode = 'json' | 'ndjson' | 'table';

/** Decide output mode from flags + TTY. Flags win; otherwise TTY => table. */
export function resolveOutputMode(
  flags: Record<string, string | boolean>,
  isTty: boolean
): OutputMode {
  if (flags.json) return 'json';
  if (flags.ndjson) return 'ndjson';
  if (flags.table) return 'table';
  return isTty ? 'table' : 'json';
}

export function renderEvents(events: ActivityEvent[], mode: OutputMode): string {
  if (mode === 'json') return JSON.stringify(events, null, 2);
  if (mode === 'ndjson') return events.map((e) => JSON.stringify(e)).join('\n');

  if (events.length === 0) return 'No activity found.';
  const rows = events.map((e) => [
    e.timestamp.replace('T', ' ').slice(0, 16),
    e.source,
    e.type,
    truncate(e.title, 70),
  ]);
  return table(['when', 'source', 'type', 'title'], rows) + `\n\n${events.length} event(s).`;
}

export function renderCredentials(statuses: CredentialStatus[]): string {
  if (statuses.length === 0) return 'No credentials registered (credentials.json is empty).';
  const rows = statuses.map((s) => [
    icon(s.state) + ' ' + s.state,
    s.env,
    s.present ? 'set' : 'MISSING',
    s.expires ?? '—',
    s.daysLeft === null ? '—' : `${s.daysLeft}d`,
    s.label ?? '',
  ]);
  const soon = statuses.filter((s) => s.state === 'soon' || s.state === 'expired');
  const summary =
    soon.length === 0
      ? '\nAll good — nothing expiring soon.'
      : `\n⚠️  ${soon.length} credential(s) need attention: ${soon.map((s) => s.env).join(', ')}`;
  return table(['state', 'env', 'value', 'expires', 'left', 'label'], rows) + '\n' + summary;
}

/** Render setup guides for one or more connectors. */
export function renderGuide(connectors: ConnectorSpec[]): string {
  const blocks = connectors.map((c) => {
    const creds = c.setup
      .map((g) => {
        const tag = g.required ? '(required)' : '(optional)';
        const steps = g.steps.map((s) => `     ${s}`).join('\n');
        return `  • ${g.env} ${tag}\n${steps}`;
      })
      .join('\n\n');
    return `━━ ${c.source} — ${c.description} ━━\n\n${creds || '  (no credentials needed)'}`;
  });
  return blocks.join('\n\n\n');
}

function icon(state: string): string {
  return { ok: '✅', soon: '⚠️', expired: '❌', never: '♾️', missing: '🚫' }[state] ?? '•';
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Render a simple aligned text table. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}
