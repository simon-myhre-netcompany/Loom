# Loom

An AI-driven interface to your work apps. `loom` is a CLI — **built for an agent
to drive** — that connects to the systems you work in (Tempo, Jira, Confluence,
GitHub, Slack, Apple Mail, Apple Calendar) and exposes them through one command,
so an assistant can fetch your history and act on your behalf instead of you
copy-pasting between apps.

Each connector emits a **normalized activity-event** stream, so everything you
did across systems merges into one timeline. On top of that the skills reason
over it: **`loom-search`** finds things across all apps (a ticket, a PR, a
thread, an email); **`loom-logg`** drafts your weekly status and fills Tempo.

Mostly **read-only**, with one deliberate write path — `loom tempo log` creates
Tempo worklogs under your own account, with confirmation. See [`GOAL.md`](./GOAL.md)
for the full motivation, design, and roadmap.

## Status

- ✅ **Tempo** worklogs — read your logged hours, **and log time** (write)
- ✅ **GitHub** PRs & commits you authored, across accounts/orgs (read-only)
- ✅ **Apple Calendar** events, local via EventKit (read-only)
- ✅ **Jira** issues you work on + your comments incl. `#TIL_KUNDE` (read-only)
- ✅ **Confluence** pages you edited — incl. your weekly status (read-only)
- ✅ **Slack** messages you sent, across workspaces (read-only)
- ✅ **Apple Mail** sent messages, local via Mail.app (read-only)
- ⬜ Teams (Graph, high friction), Azure DevOps, local git — backlog (see GOAL.md)

Everything is **read-only** except one deliberate write path: `loom tempo log`
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
npm run loom -- tempo worklogs --since 7d

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

### Logging time — `tempo log` (the one write path)

Everything else is read-only; `tempo log` is the single command that writes.
It creates a Tempo worklog under **your** account and nobody else's.

```bash
# Preview the payload without posting (always safe):
node dist/cli.js tempo log --issue TIL-123 --hours 1.5 --dry-run

# Post it — asks to confirm at a TTY; --yes skips the prompt (scripts/agents):
node dist/cli.js tempo log --issue TIL-123 --hours 1.5 --description "Refined estimate" --yes
```

On success it prints the created worklog's id and emits the event:

```text
✅ Created worklog 203604 on TIL-123.
```

**Flags**

| Flag | Required | Default | Notes |
|------|----------|---------|-------|
| `--issue <KEY\|id>` | yes | — | Jira key (`TIL-123`, resolved to Tempo's numeric id via your Atlassian creds) **or** a raw numeric issue id. |
| `--hours <n>` | yes | — | Decimals allowed (`0.5`, `1.5`). |
| `--date YYYY-MM-DD` | no | today | The work date. |
| `--start HH:mm` | no | `09:00` | Start time. Pass it if the real time matters — otherwise everything lands at 09:00. |
| `--description "..."` | no | issue summary | Free text; falls back to the issue's summary. |
| `--dry-run` | no | — | Build and print the payload, post nothing. |
| `--yes` / `-y` | no | — | Skip the confirmation prompt. |

**Guardrails**

- Needs a token with **worklog write scope** (`loom guide tempo` → grant
  MANAGE on Worklogs) *and* an account id (`TEMPO_ACCOUNT_ID` / `--user`).
  Without the account id it **refuses** — so it can never write under someone
  else, and the worklog's author is always you.
- At a terminal it prints the planned worklog and asks before posting. With no
  TTY and no `--yes` it refuses rather than posting blindly. `--dry-run`
  previews the exact payload first.

### Dual-mode

- **Agents / pipes:** JSON by default (or `--ndjson`).
- **Humans at a TTY:** a readable table; run `loom` with no args for an
  interactive menu.

### Other commands

```bash
loom guide [source]   # how to obtain each credential (e.g. the Tempo token)
loom keys             # list registered credentials + expiry
loom keys check       # exit 1 if any key expires within 30 days
loom keys add --env JIRA_API_TOKEN --expires 2027-06-05 --label "..." --source jira
```

Don't remember where a key comes from? `loom guide tempo` prints the steps.

## Architecture

- **Connectors** (`src/connectors/<source>/`) — dumb, read-only, one per source.
- **Normalized event** (`src/types.ts`) — the shared contract every connector
  emits.
- **`logg` skill** (`.claude/skills/logg/`) — orchestrates the connectors and
  reasons over the merged timeline in conversation.
