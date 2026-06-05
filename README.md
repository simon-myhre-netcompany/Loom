# Logger

Personal work-history aggregator. Read-only CLI connectors that each pull from
one source and emit a **normalized activity-event** stream, so the `logg` skill
(and you, in chat) can reason over everything you did across systems — to draft
a weekly status, decide what Tempo hours to fill, or flag follow-ups.

See [`GOAL.md`](./GOAL.md) for the full motivation, design, and roadmap.

## Status

- ✅ **Tempo** worklogs (read-only)
- ✅ **GitHub** PRs & commits you authored, across accounts/orgs (read-only)
- ✅ **Apple Calendar** events, local via EventKit (read-only)
- ✅ **Jira** issues you work on (read-only)
- ✅ **Confluence** pages you edited — incl. your weekly status (read-only)
- ✅ **Slack** messages you sent, across workspaces (read-only)
- ✅ **Apple Mail** sent messages, local via Mail.app (read-only)
- ⬜ Teams (Graph, high friction), `jira comments`, Azure DevOps, local git — backlog (see GOAL.md)

Everything is **read-only**. Writing (filling Tempo, posting comments, etc.) is
a deliberate later phase.

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
