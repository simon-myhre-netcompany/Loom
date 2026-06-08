# Logger

Personal work-history aggregator. Read-only CLI connectors that each pull from
one source and emit a **normalized activity-event** stream, so the `logg` skill
(and you, in chat) can reason over everything you did across systems — to draft
a weekly status, decide what Tempo hours to fill, or flag follow-ups.

See [`GOAL.md`](./GOAL.md) for the full motivation, design, and roadmap.

## Status

- ✅ **Tempo** worklogs — read your logged hours, **and log time** (write)
- ✅ **GitHub** PRs & commits you authored, across accounts/orgs (read-only)
- ✅ **Apple Calendar** events, local via EventKit (read-only)
- ✅ **Jira** issues you work on + your comments incl. `#TIL_KUNDE` (read-only)
- ✅ **Confluence** pages you edited — incl. your weekly status (read-only)
- ✅ **Slack** messages you sent, across workspaces (read-only)
- ✅ **Apple Mail** sent messages, local via Mail.app (read-only)
- ⬜ Teams (Graph, high friction), Azure DevOps, local git — backlog (see GOAL.md)

Everything is **read-only** except one deliberate write path: `logger tempo log`
creates Tempo worklogs. It only ever writes under your own account (it refuses
to run without `TEMPO_ACCOUNT_ID`) and confirms before posting. Other writes
(posting comments, etc.) remain a later phase.

## Setup

```bash
npm install
cp .env.example .env   # then fill in your tokens
```

Credentials live in env vars for now (`.env` is gitignored); migrating to macOS
Keychain later.

## Usage

```bash
# via npm (dev, runs TypeScript directly)
npm run logger -- tempo worklogs --since 7d

# or build once and run the binary
npm run build
node dist/cli.js tempo worklogs --since 2w --ndjson
```

Every command prints a JSON array of activity events to stdout:

```jsonc
{
  "timestamp": "2026-06-04T13:20:00",
  "source": "tempo",
  "type": "worklog",
  "ref": "tempo-issue-10432",
  "title": "Logged 2h on issue 10432",
  "body": "...",
  "url": "https://api.eu.tempo.io/...",
  "raw": { /* original payload */ }
}
```

Flags: `--since 7d|24h|2w|YYYY-MM-DD`, `--until YYYY-MM-DD`, `--ndjson`,
`--json`, `--table`, `-i`/`--interactive`, `--no-interactive`, `--token`,
`--user`.

### Logging time (the one write path)

```bash
# Preview the payload without posting:
node dist/cli.js tempo log --issue TIL-123 --hours 1.5 --dry-run

# Post it (asks to confirm at a TTY; --yes skips the prompt for scripts/agents):
node dist/cli.js tempo log --issue TIL-123 --hours 1.5 --description "Refined estimate"
```

- `--issue` takes a Jira key (`TIL-123`, resolved to its numeric id via the
  Jira connector's Atlassian creds) **or** a raw numeric issue id directly.
- `--date YYYY-MM-DD` (default today), `--start HH:mm` (default 09:00),
  `--description` (defaults to the issue summary), `--hours` accepts decimals.
- **Guardrails:** needs a token with worklog write scope *and* an account id
  (`TEMPO_ACCOUNT_ID` / `--user`) — without the account id it refuses, so it can
  never write under someone else. At a TTY it prints the planned worklog and
  asks before posting; `--dry-run` previews, `--yes` skips the prompt.

### Dual-mode

- **Agents / pipes:** JSON by default (or `--ndjson`).
- **Humans at a TTY:** a readable table; run `logger` with no args for an
  interactive menu.

### Other commands

```bash
logger guide [source]   # how to obtain each credential (e.g. the Tempo token)
logger keys             # list registered credentials + expiry
logger keys check       # exit 1 if any key expires within 30 days
logger keys add --env JIRA_API_TOKEN --expires 2027-06-05 --label "..." --source jira
```

Don't remember where a key comes from? `logger guide tempo` prints the steps.

## Architecture

- **Connectors** (`src/connectors/<source>/`) — dumb, read-only, one per source.
- **Normalized event** (`src/types.ts`) — the shared contract every connector
  emits.
- **`logg` skill** (`.claude/skills/logg/`) — orchestrates the connectors and
  reasons over the merged timeline in conversation.
