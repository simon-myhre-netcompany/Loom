---
name: loom-search
description: Use Loom (the `loom` CLI) to fetch and search Simon's work across all the apps it integrates (Tempo, Jira, Confluence, GitHub, Slack, Apple Mail, Apple Calendar) — e.g. find a Jira task, a PR, a Slack message, an email, a meeting, or a worklog — so he never has to copy-paste from an app into the chat. Use whenever Simon asks you to look something up, find a ticket/PR/message/page, or pull context from one of his work apps.
---

# loom-search

**Loom** is a CLI (`loom`) with read access to many of the apps Simon works in.
It is **built for an AI (you) to use** — the whole point is to speed up his work:
instead of Simon copy-pasting a ticket, a thread, or an email from an app into
the chat, **you fetch it yourself with Loom**. Use it both to *find* things and
to *pull in context* you need to help him.

Apps Loom can search:

- **tempo** — his logged hours (worklogs) and billing accounts.
- **jira** — issues he works on, and comments (his, or everyone's with `--all`).
- **confluence** — pages he's edited (incl. his weekly status).
- **github** — PRs & commits he authored (personal + oslo-kommune org).
- **slack** — messages he sent, across workspaces.
- **mail** — Apple Mail messages he sent (Netcompany + Oslo kommune).
- **calendar** — Apple Calendar meetings & events (local).

> This skill is **read-only / search**. Loom *can* write (worklogs, a ticket's
> Account, and Jira fields), but that lives in the `loom-logg` skill.

## How to search

`loom` is globally installed — call it directly. Every command prints a JSON
array of normalized events (`{ timestamp, source, type, ref, title, body?,
url? }`), so results from different apps merge cleanly.

```bash
loom jira issues --since 2w --json                 # your recent issues
loom jira issues --jql "key = UKESASADF-937" --json  # a specific ticket
loom jira comments --key UKESASADF-937 --json      # your comments on one ticket
loom jira comments --key UKESASADF-937 --all --json  # the WHOLE thread (everyone)
loom github prs --since 2w --json                  # PRs you authored
loom github commits --since 1w --json
loom slack messages --since 1w --json              # messages you sent
loom mail sent --since 2w --json                   # emails you sent
loom confluence pages --since 30d --json           # pages you edited
loom calendar events --since 1w --json
loom tempo worklogs --since 1w --json
loom tempo accounts --search tjenestelag --json    # find a Tempo billing account
```

> Search/read only. Writing (worklogs, setting a ticket's Account, and the
> `jira` write actions) lives in the `loom-logg` skill — use that when Simon
> wants to *change* something.

Useful flags: `--since 7d|24h|2w|YYYY-MM-DD`, `--until YYYY-MM-DD`, `--json`
(default for agents), `--ndjson`. Jira takes `--jql "..."` for a precise query
and `--key ABC-1,ABC-2` to target specific tickets. `jira comments` defaults to
*your* comments; add `--all` to get every author's (with `--key`, the full
thread regardless of date). Run `loom --help` (or
`loom guide <source>`) to see what's wired up.

## How to use it well

- **Fetch instead of asking Simon to paste.** If he mentions a ticket key, a PR,
  a person, or a date range, go get it with Loom rather than asking him to copy
  it in.
- **Pick the narrowest query.** Use `--jql` / `--key` / a tight `--since` so you
  pull the few relevant events, not everything.
- **Stitch across apps.** A Jira key (e.g. `UKESASADF-1917`) shows up in GitHub
  PR/commit titles, Slack, and mail too — use it to assemble the full story of a
  task (code + status + customer comms).
- **Cite what you found** (`ref`, `url`) so Simon can click through.
- If a connector errors (missing token, network), say so and use the sources
  that worked — don't invent results.
