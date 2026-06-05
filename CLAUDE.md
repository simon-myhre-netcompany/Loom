# CLAUDE.md — working in the Logger repo

Logger is a **read-only** work-history aggregator: small CLI connectors (one per
source) emit a normalized `ActivityEvent` stream that the `logg` skill reasons
over. See `GOAL.md` for the full motivation and roadmap, `README.md` for usage.

## Golden rule: build and test after every change

This is a real CLI — verify it actually runs, don't just eyeball the diff. After
any change to `src/`:

```bash
npm run typecheck   # tsc --noEmit — must pass
npm run build       # emit dist/
```

Then exercise the affected command and confirm the output. Examples:

```bash
node dist/cli.js tempo worklogs --since 14d --json   # fetch (needs creds)
node dist/cli.js keys                                 # credential expiry table
node dist/cli.js keys check                           # exit 1 if any expire soon
node dist/cli.js guide tempo                           # setup instructions
node dist/cli.js --help
```

Fast iteration without building (runs the TypeScript directly):

```bash
npm run logger -- tempo worklogs --since 7d
```

## Tools available in this project

- **`logger <source> <action> [flags]`** — fetch activity events. Today:
  `tempo worklogs`. Flags: `--since 7d|2w|YYYY-MM-DD`, `--until`, `--token`,
  `--user`.
- **`logger guide [source]`** — step-by-step on how to obtain each credential.
- **`logger keys [list|add|check]`** — credential expiry tracking. `check` exits
  non-zero when a key expires within 30 days. `add --env X --expires YYYY-MM-DD`.
- **The `logg` skill** (`.claude/skills/logg/`) — orchestrates the connectors to
  draft weekly status, suggest Tempo entries, and flag follow-ups.

### Output modes (dual-mode CLI)

- **Agents / pipes:** default to JSON (`--json`), or `--ndjson`. Always pass
  `--no-interactive` from scripts to be safe.
- **Humans at a TTY:** default to a readable table; `logger` with no args opens
  an interactive menu. Force with `-i`/`--interactive`.

## Conventions

- **Read-only.** v1 connectors must have no write code paths and no write
  credentials. Writing is a deliberate later phase (see GOAL.md).
- **Every connector emits `ActivityEvent`** (`src/types.ts`) — keep the shape
  stable; add fields rather than renaming.
- **Register new connectors in `src/registry.ts`** (description, actions,
  prompts, and a `setup` guide for their credentials).
- **Credentials:** secrets in env vars (`.env`, gitignored). Only *metadata*
  (expiry) goes in `credentials.json`. Never commit a secret.
- **No runtime dependencies** so far (stdlib only). Keep it that way unless
  there's a strong reason.
- **Conventional commits.** Commit when work is finished; never push unless told.
