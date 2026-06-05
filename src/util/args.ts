/**
 * Minimal flag parser. No dependencies — we only need the basics.
 *
 *   parseFlags(["--since", "7d", "--ndjson"])
 *     => { since: "7d", ndjson: true }
 *
 * `--key value` sets a string; `--flag` with no following value (or followed by
 * another `--flag`) is a boolean true.
 */
export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

/** Read a string flag, falling back to an env var, then a default. */
export function flagOrEnv(
  flags: Record<string, string | boolean>,
  flagName: string,
  envName: string,
  fallback?: string
): string | undefined {
  const f = flags[flagName];
  if (typeof f === 'string') return f;
  return process.env[envName] ?? fallback;
}
