#!/usr/bin/env node
/**
 * logger — read-only work-history aggregator.
 *
 *   logger <source> <action> [flags]
 *
 * Every command prints a JSON array of normalized ActivityEvents to stdout.
 * Use --ndjson for one event per line. Errors go to stderr with exit code 1.
 */
import { readFileSync } from 'node:fs';
import type { ActivityEvent } from './types.js';
import * as tempo from './connectors/tempo/index.js';

type Connector = (action: string | undefined, argv: string[]) => Promise<ActivityEvent[]>;

const CONNECTORS: Record<string, Connector> = {
  tempo: tempo.run,
};

async function main(): Promise<void> {
  loadDotEnv();

  const [, , source, action, ...rest] = process.argv;

  if (!source || source === '--help' || source === '-h') {
    printHelp();
    process.exit(source ? 0 : 1);
  }

  const connector = CONNECTORS[source];
  if (!connector) {
    fail(`unknown source "${source}". Available: ${Object.keys(CONNECTORS).join(', ')}`);
  }

  const events = await connector(action, rest);

  const ndjson = rest.includes('--ndjson');
  if (ndjson) {
    for (const e of events) process.stdout.write(JSON.stringify(e) + '\n');
  } else {
    process.stdout.write(JSON.stringify(events, null, 2) + '\n');
  }
}

function printHelp(): void {
  const lines = [
    'logger — read-only work-history aggregator',
    '',
    'usage: logger <source> <action> [flags]',
    '',
    'sources:',
    '  tempo worklogs   Fetch your Tempo worklogs as activity events',
    '',
    'common flags:',
    '  --since 7d       Look back this far (7d, 24h, 2w, or YYYY-MM-DD)',
    '  --until DATE     End date (YYYY-MM-DD; default today)',
    '  --ndjson         One JSON event per line instead of a pretty array',
    '',
    'credentials come from environment variables (see .env.example).',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Tiny .env loader so `tsx src/cli.ts` and the built binary both pick up local
 * credentials without a dependency. Only sets vars not already in the env.
 */
function loadDotEnv(): void {
  // Look for .env next to the project root (works from src/ via tsx and dist/).
  const candidates = [
    new URL('../.env', import.meta.url), // dist/.env  -> project root when built
    new URL('../../.env', import.meta.url), // src/.env -> project root via tsx
  ];
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
  process.stderr.write(`logger: ${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
