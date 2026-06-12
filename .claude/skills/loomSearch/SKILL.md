---
name: loomSearch
description: Use Loom (the `loom` CLI) to fetch and search the user's work across all the apps it integrates (Tempo, Jira, Confluence, GitHub, Slack, Apple Mail, Apple Calendar) — e.g. find a Jira task, a PR, a Slack message, an email, a meeting, or a worklog — so they never have to copy-paste from an app into the chat. Use whenever the user asks you to look something up, find a ticket/PR/message/page, or pull context from one of their work apps.
---

# loomSearch

**Loom** is a CLI (`loom`) with read access to many of the apps the user works
in. It is **built for an AI (you) to use** — the whole point is to speed up
their work: instead of the user copy-pasting a ticket, a thread, or an email
from an app into the chat, **you fetch it yourself with Loom**. Use it both to
*find* things and to *pull in context* you need to help them.

Apps Loom can search:

- **tempo** — logged hours (worklogs) and billing accounts.
- **jira** — issues the user works on, and comments (theirs, or everyone's with
  `--all`).
- **confluence** — pages they've edited (incl. their weekly status).
- **github** — PRs & commits they authored (across accounts/orgs).
- **slack** — messages: theirs by default, or any channel / person / free-text
  search they can see; `history` walks one channel completely (bot posts included).
- **mail** — Apple Mail messages they sent or received.
- **calendar** — calendar meetings & events.

> This skill is **read-only / search**. Loom *can* write (worklogs, a ticket's
> Account, and Jira fields), but that lives in the `loomLogg` skill.

## How to search

`loom` is globally installed — call it directly. Every command prints a JSON
array of normalized events (`{ timestamp, source, type, ref, title, body?,
url? }`), so results from different apps merge cleanly.

```bash
loom jira issues --since 2w --json                 # recent issues
loom jira issues --jql "key = ABC-123" --json      # a specific ticket
loom jira comments --key ABC-123 --json            # the user's comments on one ticket
loom jira comments --key ABC-123 --all --json      # the WHOLE thread (everyone)
loom github prs --since 2w --json                  # PRs the user authored
loom github commits --since 1w --json
loom slack messages --since 1w --json              # messages the user sent
loom slack messages --channel team-x --since 3d --json   # everyone's messages in #team-x
loom slack messages --query "deploy failed" --json # free-text search
loom slack messages --from @kari --since 7d --json # one person's messages
loom slack history --channel team-x --since 3d --json    # full channel history, incl. bots
#   (history needs channels:read + channels:history token scopes; search needs
#    only search:read. Buttons in app messages CANNOT be clicked via API.)
loom mail sent --since 2w --json                   # emails the user sent
loom confluence pages --since 30d --json           # pages the user edited
loom calendar events --since 1w --json
loom tempo worklogs --since 1w --json
loom tempo accounts --search <text> --json         # find a Tempo billing account
```

> Search/read only. Writing (worklogs, setting a ticket's Account, and the
> `jira` write actions) lives in the `loomLogg` skill — use that when the user
> wants to *change* something.

Useful flags: `--since 7d|24h|2w|YYYY-MM-DD`, `--until YYYY-MM-DD`, `--json`
(default for agents), `--ndjson`. Jira takes `--jql "..."` for a precise query
and `--key ABC-1,ABC-2` to target specific tickets. `jira comments` defaults to
the *user's* comments; add `--all` to get every author's (with `--key`, the
full thread regardless of date). Run `loom --help` (or `loom guide <source>`)
to see what's wired up.

## How to use it well

- **Fetch instead of asking the user to paste.** If they mention a ticket key,
  a PR, a person, or a date range, go get it with Loom rather than asking them
  to copy it in.
- **Pick the narrowest query.** Use `--jql` / `--key` / a tight `--since` so you
  pull the few relevant events, not everything.
- **Stitch across apps.** A Jira key (e.g. `ABC-123`) shows up in GitHub
  PR/commit titles, Slack, and mail too — use it to assemble the full story of a
  task (code + status + customer comms).
- **Cite what you found** (`ref`, `url`) so the user can click through.
- If a connector errors (missing token, network), say so and use the sources
  that worked — don't invent results.
- **If Loom doesn't work, do NOT bypass it** — never call the underlying APIs
  (Jira/Tempo/Atlassian REST, GitHub, Slack, ...) directly with curl/fetch or
  by reading tokens from `.env`. Stop, tell the user it does not work, and give
  the probable cause (read the error: expired/missing token → `loom keys` /
  `loom guide <source>`, network/VPN, a Loom bug, ...). Loom is the boundary
  that keeps access guarded; going around it defeats that.
