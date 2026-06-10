# CLAUDE.md — working in the Loom repo

Loom is a **read-only** work-history aggregator: small CLI connectors (one per
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
npm run loom -- tempo worklogs --since 7d
```

For changes that touch portability (platform checks, the calendar/mail
connectors, the Dockerfile), also verify the Ubuntu container path (needs
`colima start` first):

```bash
scripts/loom-docker.sh --help                              # builds image if missing
LOOM_DOCKER_BUILD=1 scripts/loom-docker.sh keys            # force rebuild + run
scripts/loom-docker.sh tempo worklogs --since 7d --json --no-interactive
```

## Tools available in this project

- **`loom <source> <action> [flags]`** — fetch activity events. e.g.
  `tempo worklogs`. Flags: `--since 7d|2w|YYYY-MM-DD`, `--until`, `--token`,
  `--user`.
- **`loom tempo log`** — create a Tempo worklog. `--issue <KEY|id>`,
  `--hours <n>`, `--date`, `--start`, `--description`, `--dry-run`, `--yes`.
  Refuses without an account id; confirms before posting.
- **`loom tempo accounts`** — list Tempo accounts (billing buckets). `--search`
  to filter by key/name, `--all` to include closed ones.
- **`loom tempo set-account`** — guarded write: set an issue's Tempo Account
  field. `--issue <KEY>`, `--account <key|id|none>`, `--dry-run`, `--yes`. The
  Account is a per-instance Tempo (Forge) custom field; the field id defaults to
  `customfield_10039` and is overridable via `--account-field` /
  `JIRA_ACCOUNT_FIELD`. Resolving an account by key/name needs `TEMPO_API_TOKEN`
  (a numeric id doesn't).
- **`loom jira <comment|transition|describe|estimate|assign|rename|labels|set>`**
  — guarded Jira writes, one issue at a time via `--key`. `comment`/`describe`
  take `--body`; `transition`/`assign`/`rename` take `--to`; `transition` also
  takes screen fields required by the workflow — `--resolution "Fixed"` and a
  repeatable `--field "Name=value"` (e.g. `--field "Løsningsmetode=..."`),
  validated against the target transition's own screen; `estimate` takes
  `--original`/`--remaining` (Jira durations like `3h`, `1d 4h`); `labels` takes
  `--add`/`--remove` (comma-sep); `set` takes `--priority`/`--due` (YYYY-MM-DD);
  `assign --to` accepts a name/email/`me`/`none`. All preview the change and
  confirm before writing (`--dry-run` to preview, `--yes` to skip the prompt);
  they act as the authenticated Atlassian user.
- **`loom status`** — per-connector availability on this machine (required env
  vars set? platform supported?). No network calls. Connectors are independent:
  configure only what you use; the rest shows as unconfigured.
- **`loom guide [source]`** — step-by-step on how to obtain each credential.
- **`loom calendar events`** — dual backend: Apple Calendar (EventKit) on
  macOS; ICS feeds (`CALENDAR_ICS_URL`/`CALENDAR_ICS_URL_<NAME>`, `--ics` to
  force) on Linux/containers. `mail` (sent + inbox) is macOS-only — disabled
  on Linux by decision; it exits with a clear message there.
- **Ubuntu/container:** `docker build -t loom .` or `scripts/loom-docker.sh
  <args>` — all API connectors + ICS calendar work there; secrets are never
  baked into the image (`.env` is mounted read-only at runtime).
- **`loom keys [list|add|check]`** — credential expiry tracking. `check` exits
  non-zero when a key expires within 30 days. `add --env X --expires YYYY-MM-DD`
  also stores the secret itself in `.env` (hidden prompt at a TTY, or pipe it
  via `--value-stdin`); the file is created 0600 and the var's line replaced
  in place on rotation.
- **The `logg` skill** (`.claude/skills/logg/`) — orchestrates the connectors to
  draft weekly status, suggest Tempo entries, and flag follow-ups.

### Output modes (dual-mode CLI)

- **Agents / pipes:** default to JSON (`--json`), or `--ndjson`. Always pass
  `--no-interactive` from scripts to be safe.
- **Humans at a TTY:** default to a readable table; `loom` with no args opens
  an interactive menu. Force with `-i`/`--interactive`.

## Conventions

- **Read-only by default.** The write paths so far are `loom tempo log` (create
  a worklog) and the guarded `loom jira` writes (`comment`, `transition`,
  `describe`, `estimate`). Any new write path must be just as guarded: a
  dedicated action, acting only as the authenticated user (no impersonation) so
  we never write on someone else's behalf, and a confirm/`--dry-run`/`--yes`
  flow. Everything else stays read-only. Broader writing is still a deliberate
  later phase (see GOAL.md).
- **Every connector emits `ActivityEvent`** (`src/types.ts`) — keep the shape
  stable; add fields rather than renaming.
- **Register new connectors in `src/registry.ts`** (description, actions,
  prompts, and a `setup` guide for their credentials).
- **Credentials:** secrets in env vars (`.env`, gitignored). Only *metadata*
  (expiry) goes in `credentials.json`. Never commit a secret.
- **No runtime dependencies** so far (stdlib only). Keep it that way unless
  there's a strong reason.
- **Conventional commits.** Commit when work is finished; never push unless told.
