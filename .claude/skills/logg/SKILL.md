---
name: logg
description: Gather Simon's recent work history from connected sources (Tempo today; git, Jira, Confluence, calendar later) via the read-only `logger` CLI, then help draft weekly status, decide what Tempo hours to fill, and flag follow-ups (customer replies, estimate/deadline updates). Use when Simon says "logg", asks for a weekly status draft, wants to know what to fill in Tempo, or asks what he worked on / needs to follow up on.
---

# logg

Help Simon turn scattered work history into drafts and reminders. The heavy
lifting of *fetching* is done by the read-only `logger` CLI; your job is to call
it, merge the results into one timeline, and reason over it **with** him. Simon
applies changes manually — this skill never writes to any system.

## How to fetch

Run the CLI from the project root (`/Users/simonm/workdir/netcompany/Logger`).
Each command prints a JSON array of normalized activity events:

```bash
npm run logger -- tempo worklogs --since 7d
```

Common flags: `--since 7d|24h|2w|YYYY-MM-DD`, `--until YYYY-MM-DD`, `--ndjson`.

Every event has the same shape, so you can merge sources freely:

```jsonc
{ "timestamp", "source", "type", "ref", "title", "body?", "url?", "raw?" }
```

### Available connectors

- **tempo** — `tempo worklogs` → your logged hours (source of truth for time).
- **github** — `github prs` and `github commits` → PRs and commits you authored,
  merged across your personal account and the oslo-kommune org.
- **calendar** — `calendar events` → Apple Calendar meetings & events (local,
  EventKit). Note the `Birthdays` / `Siri Suggestions` / holiday calendars are
  noise — focus on real meetings when drafting status.
- **jira** — `jira issues` → issues you're assigned to / logged work on. Issue
  keys (e.g. `UKESASADF-1917`) also appear in GitHub PR/commit titles, so use
  them to stitch a ticket's code + status into one story. `#TIL_KUNDE` in
  comments marks customer-facing updates.

- **confluence** — `confluence pages` → pages you've edited, incl. your weekly
  status page ("Status Team Arkiv"). Read the previous status page for tone and
  structure, then fill it with this week's activity from the other sources.

- **slack** — `slack messages` → messages you sent (DMs + channels), across
  workspaces. Good for "informed/coordinated with X" lines; note most are short
  DMs, so summarize themes rather than quoting every message.

(Check `logger --help` for what's currently wired up before assuming a source
exists.)

## What to produce

Pick based on what Simon asks for:

- **Weekly status draft** — group the timeline by theme/ticket, summarize into
  the bullet style his Confluence status uses. Lead with outcomes, not activity.
- **Tempo fill suggestions** — from the timeline, propose what hours go where.
  Remember the rules: **max 2.5h per entry**; split longer work across multiple
  entries; Tempo is submitted monthly.
- **Follow-up reminders** — surface tickets that look like they need a customer
  reply (the `#TIL_KUNDE` convention), a progress update, or an estimate/deadline
  refresh.

## Working style

- Always show your sources: cite the events (`ref`, `url`) behind each claim so
  Simon can verify.
- If a connector errors (missing token, network), say so plainly and continue
  with whatever other sources succeeded — don't fabricate history.
- Draft, then iterate with him. He decides; he applies.
