#!/usr/bin/env node
/**
 * loom — read-only work-history aggregator.
 *
 *   loom <source> <action> [flags]      e.g. loom tempo worklogs --since 7d
 *   loom keys [list|add|check]          credential expiry tracking
 *   loom                                interactive menu (at a TTY)
 *
 * Dual-mode by design:
 *   - Non-interactive (agents / pipes): prints JSON to stdout.
 *   - Interactive (humans at a TTY): menu-driven, prints a readable table.
 * Both honour --json / --ndjson / --table and --help/-h.
 */
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import type { ActivityEvent } from './types.js';
import { CONNECTORS, getConnector, type ConnectorSpec } from './registry.js';
import { resolveOutputMode, renderEvents, renderCredentials, renderGuide } from './output.js';
import { ask, askHidden, select, closeInteractive } from './interactive.js';
import {
  loadRegistry,
  statusReport,
  upsertEntry,
  setEnvSecret,
  parseEnvText,
  importEnvSecrets,
  type CredentialEntry,
} from './credentials.js';
import { parseFlags } from './util/args.js';

async function main(): Promise<void> {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);

  if (flags.help || flags.h || argv[0] === 'help') {
    printHelp();
    return;
  }

  // Positionals are the leading tokens before the first flag (canonical form is
  // `source action [flags]`), so flag *values* are never mistaken for them.
  const positionals: string[] = [];
  for (const a of argv) {
    if (a.startsWith('-')) break;
    positionals.push(a);
  }
  const [source, action] = positionals;

  const interactive = isInteractive(flags);

  // --- guide: how to obtain credentials -------------------------------------
  if (source === 'guide') {
    handleGuide(action);
    return;
  }

  // --- keys: credential expiry tracking -------------------------------------
  if (source === 'keys') {
    await handleKeys(action, flags, interactive);
    return;
  }

  // --- status: which connectors are usable right now (env + platform) -------
  if (source === 'status') {
    handleStatus(flags);
    return;
  }

  // --- pick a connector (interactively if none given) -----------------------
  let connector: ConnectorSpec | undefined;
  if (source) {
    connector = getConnector(source);
    if (!connector) {
      fail(
        `unknown source "${source}". Available: ${CONNECTORS.map((c) => c.source).join(', ')}, keys`
      );
    }
  } else if (interactive) {
    connector = await select('Which source?', CONNECTORS, (c) => `${c.source} — ${c.description}`);
  } else {
    printHelp();
    process.exit(1);
  }

  // --- pick an action + gather flags ----------------------------------------
  const extraArgv = await resolveAction(connector!, action, argv, interactive);

  const events: ActivityEvent[] = await connector!.run(extraArgv.action, extraArgv.argv);

  const mode = resolveOutputMode(flags, stdout.isTTY ?? false);
  stdout.write(renderEvents(events, mode) + '\n');
}

/**
 * Determine the action and the full argv to pass the connector. In interactive
 * mode, prompts for any missing action and prompt-able flags.
 */
async function resolveAction(
  connector: ConnectorSpec,
  action: string | undefined,
  argv: string[],
  interactive: boolean
): Promise<{ action: string | undefined; argv: string[] }> {
  let chosen = action;
  if (!chosen && interactive && connector.actions.length > 0) {
    const a = await select(
      `Which ${connector.source} action?`,
      connector.actions,
      (x) => `${x.name} — ${x.description}`
    );
    chosen = a.name;
  }

  const argvOut = [...argv];
  if (interactive && chosen) {
    const spec = connector.actions.find((a) => a.name === chosen);
    const present = new Set(parseFlagKeys(argv));
    for (const p of spec?.prompts ?? []) {
      if (p.prompt === false) continue;
      if (present.has(p.key)) continue;
      const value = await ask(p.label, p.default);
      if (value) argvOut.push(`--${p.key}`, value);
    }
  }
  return { action: chosen, argv: argvOut };
}

// ---------------------------------------------------------------------------
// guide command — how to get each credential
// ---------------------------------------------------------------------------

function handleGuide(source: string | undefined): void {
  if (source) {
    const c = getConnector(source);
    if (!c) fail(`guide: unknown source "${source}". Available: ${CONNECTORS.map((x) => x.source).join(', ')}`);
    stdout.write(renderGuide([c!]) + '\n');
  } else {
    stdout.write(renderGuide(CONNECTORS) + '\n');
  }
}

// ---------------------------------------------------------------------------
// status command — per-connector availability, no network calls
// ---------------------------------------------------------------------------

function handleStatus(flags: Record<string, string | boolean>): void {
  const report = CONNECTORS.map((c) => ({ source: c.source, ...c.availability() }));
  if (flags.json) {
    stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const icon = { ready: '✅', unconfigured: '⚠️', disabled: '🚫' } as const;
  const width = Math.max(...report.map((r) => r.source.length));
  for (const r of report) {
    stdout.write(
      `${icon[r.state]} ${r.source.padEnd(width)}  ${r.state.padEnd(12)}  ${r.detail}\n`
    );
  }
  const off = report.filter((r) => r.state !== 'ready').length;
  stdout.write(
    off === 0
      ? '\nAll connectors ready.\n'
      : `\n${report.length - off}/${report.length} ready. \`loom guide <source>\` explains the missing pieces.\n`
  );
}

// ---------------------------------------------------------------------------
// keys command
// ---------------------------------------------------------------------------

async function handleKeys(
  sub: string | undefined,
  flags: Record<string, string | boolean>,
  interactive: boolean
): Promise<void> {
  if (sub === 'add') {
    await keysAdd(flags, interactive);
    return;
  }

  if (sub === 'import') {
    keysImport(flags);
    return;
  }

  // list / check (default = list)
  const onlySoon = sub === 'check' || !!flags.soon;
  let report = statusReport();
  if (onlySoon) report = report.filter((s) => s.state === 'soon' || s.state === 'expired');

  if (flags.json) {
    stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (onlySoon && report.length === 0) {
    stdout.write('✅ No credentials expiring soon (within 30 days) and none expired.\n');
  } else {
    stdout.write(renderCredentials(report) + '\n');
  }

  // `check` exits non-zero when something needs attention, for scripting.
  if (sub === 'check') {
    const attention = statusReport().some((s) => s.state === 'soon' || s.state === 'expired');
    process.exit(attention ? 1 : 0);
  }
}

async function keysAdd(
  flags: Record<string, string | boolean>,
  interactive: boolean
): Promise<void> {
  let env = typeof flags.env === 'string' ? flags.env : undefined;
  let label = typeof flags.label === 'string' ? flags.label : undefined;
  let srcName = typeof flags.source === 'string' ? flags.source : undefined;
  // --expires YYYY-MM-DD, or --expires never / "" for no expiry.
  let expiresRaw = typeof flags.expires === 'string' ? flags.expires : undefined;

  if (interactive) {
    env ??= await ask('Env var name (e.g. JIRA_API_TOKEN)');
    label ??= await ask('Label (optional)');
    srcName ??= await ask('Source/connector (optional, e.g. jira)');
    expiresRaw ??= await ask('Expires (YYYY-MM-DD, or "never")', 'never');
  }

  if (!env) fail('keys add: --env is required (or run interactively).');

  // Optionally store the secret itself in .env, so setup is one command.
  // Sources, by preference: piped stdin (--value-stdin, for scripts/agents),
  // an explicit --value (convenient but lands in shell history — discouraged),
  // or a hidden interactive prompt.
  let value: string | undefined;
  if (flags['value-stdin']) {
    value = readFileSync(0, 'utf8').trim();
    if (!value) fail('keys add: --value-stdin given but stdin was empty.');
  } else if (typeof flags.value === 'string') {
    value = flags.value;
  } else if (interactive) {
    const v = await askHidden(`Paste the ${env} secret (blank to skip)`);
    if (v) value = v;
  }

  const expires = parseExpires(expiresRaw);
  const entry: CredentialEntry = {
    env: env!,
    ...(label ? { label } : {}),
    ...(srcName ? { source: srcName } : {}),
    expires,
  };
  upsertEntry(entry);
  if (value) {
    const path = setEnvSecret(env!, value);
    stdout.write(`Stored the secret in ${path}.\n`);
  }
  stdout.write(`Registered ${entry.env} (expires: ${expires ?? 'never'}).\n`);
  stdout.write(renderCredentials(statusReport()) + '\n');
}

/**
 * loom keys import --file <path> [--dry-run]
 * Merge every var from an env-format file into the project's .env.
 * Expected format: one NAME=VALUE per line; `#` comments and blank lines are
 * ignored; the value is everything after the first `=` (verbatim — no quotes,
 * no `export` prefix, no multi-line values).
 */
function keysImport(flags: Record<string, string | boolean>): void {
  const file = typeof flags.file === 'string' ? flags.file : undefined;
  if (!file) {
    fail(
      'keys import: --file <path> is required.\n' +
        'File format: one NAME=VALUE per line, # comments and blank lines ignored,\n' +
        'value taken verbatim after the first "=" (no quotes, no "export" prefix).'
    );
  }
  let text: string;
  try {
    text = readFileSync(file!, 'utf8');
  } catch (err) {
    fail(`keys import: cannot read "${file}": ${(err as Error).message}`);
  }
  const pairs = parseEnvText(text!);
  const names = Object.keys(pairs);
  if (names.length === 0) {
    fail(
      `keys import: no NAME=VALUE lines found in "${file}". ` +
        'Expected one NAME=VALUE per line (# comments and blanks are ignored).'
    );
  }
  if (flags['dry-run']) {
    stdout.write(`Would import ${names.length} var(s) into .env:\n  ${names.join('\n  ')}\n`);
    return;
  }
  const path = importEnvSecrets(pairs);
  stdout.write(`Imported ${names.length} var(s) into ${path}:\n  ${names.join('\n  ')}\n`);
  stdout.write(renderCredentials(statusReport()) + '\n');
}

function parseExpires(raw: string | undefined): string | null {
  if (!raw || raw.toLowerCase() === 'never' || raw === '-') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    fail(`keys add: --expires must be YYYY-MM-DD or "never", got "${raw}".`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isInteractive(flags: Record<string, string | boolean>): boolean {
  if (flags.interactive || flags.i) return true;
  if (flags['no-interactive']) return false;
  return !!(stdin.isTTY && stdout.isTTY);
}

function parseFlagKeys(argv: string[]): string[] {
  return Object.keys(parseFlags(argv));
}

function printHelp(): void {
  const sources = CONNECTORS.map(
    (c) =>
      `  ${c.source.padEnd(8)} ${c.description}\n` +
      c.actions.map((a) => `    └ ${a.name.padEnd(10)} ${a.description}`).join('\n')
  ).join('\n');

  stdout.write(
    [
      'loom — read-only work-history aggregator',
      '',
      'usage:',
      '  loom <source> <action> [flags]   fetch activity events',
      '  loom status                      which connectors are usable here (env/platform)',
      '  loom guide [source]              how to obtain the credentials',
      '  loom keys [list|add|check]       credential expiry tracking',
      '  loom                             interactive menu (at a TTY)',
      '',
      'sources:',
      sources,
      '',
      'fetch flags:',
      '  --since 7d        look back (7d, 24h, 2w, or YYYY-MM-DD; default 7d)',
      '  --until DATE      end date (YYYY-MM-DD; default today)',
      '',
      'output:',
      '  --json            machine-readable JSON array (default when piped)',
      '  --ndjson          one JSON event per line',
      '  --table           human table (default at a TTY)',
      '',
      'mode:',
      '  -i, --interactive force interactive prompts',
      '  --no-interactive  never prompt (for agents/scripts)',
      '  -h, --help        show this help',
      '',
      'keys:',
      '  loom keys                 list registered credentials + expiry',
      '  loom keys check           exit 1 if any expire soon (<30d) or expired',
      '  loom keys add --env X --expires YYYY-MM-DD [--label .. --source ..]',
      '                            also stores the secret in .env: prompts',
      '                            hidden at a TTY, or pipe it with --value-stdin',
      '  loom keys import --file F [--dry-run]',
      '                            merge a whole env-format file into .env',
      '                            (one NAME=VALUE per line; # comments ignored;',
      '                            value verbatim after the first "=" — no quotes,',
      '                            no "export" prefix)',
      '',
      'credentials come from environment variables. Three ways to provide them:',
      '  1. write .env yourself at setup (copy .env.example and fill in),',
      '  2. per key:    loom keys add --env NAME --expires DATE',
      '  3. bulk:       loom keys import --file my-secrets.env',
    ].join('\n') + '\n'
  );
}

/**
 * Tiny .env loader — no dependency. Only sets vars not already in the env.
 * Looks for .env at the project root from both `tsx src/cli.ts` and dist/.
 */
function loadDotEnv(): void {
  const candidates = [new URL('../.env', import.meta.url), new URL('../../.env', import.meta.url)];
  let text: string | undefined;
  for (const path of candidates) {
    try {
      text = readFileSync(path, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (text === undefined) return;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

function fail(message: string): never {
  process.stderr.write(`loom: ${message}\n`);
  process.exit(1);
}

main()
  .then(() => closeInteractive())
  .catch((err: unknown) => {
    closeInteractive();
    fail(err instanceof Error ? err.message : String(err));
  });
