---
name: loom-logg
description: Use Loom (the `loom` CLI) to search Simon's recent work history across all the apps it integrates (Tempo, Jira, Confluence, GitHub, Slack, Apple Mail, Apple Calendar), then help him either fill Tempo (Loom can WRITE worklogs — but discuss before writing) or draft his ukentlig status (weekly status). Use when Simon says "loom logg", "logg", asks what to fill in Tempo, asks for a weekly status / ukentlig status draft, or asks what he worked on.
---

# loom-logg

**Loom** is a CLI (`loom`) that integrates across the apps Simon works in and is
**built for an AI (you) to drive** — so you can pull his real work history
yourself instead of him copy-pasting it. Apps it integrates:

- **tempo** — logged hours. **Read and write**: create worklogs (`tempo log`),
  list billing accounts (`tempo accounts`), and set an issue's Account
  (`tempo set-account`).
- **jira** — issues + comments (his, or **everyone's** with `--all`). Also
  **guarded writes**: `comment`, `transition` (status), `describe`, `estimate`,
  `assign`, `rename`, `labels`, `set` (priority/due).
  **Closing/resolving a ticket**: the workflow requires extra screen fields —
  pass `--resolution "Fixed"` and `--field "Løsningsmetode=<how it was solved>"`
  on `transition` (`--field "Name=value"` is repeatable, sets any field on the
  target transition's screen, and validates the value against Jira's allowed
  list before sending). E.g.:
  `loom jira transition --key UKESASADF-1960 --to Resolved --resolution Fixed
  --field "Løsningsmetode=Konfig rettet i kong-terraform-config" --dry-run`
- **confluence** — pages he edited, incl. his weekly-status page.
- **github** — PRs & commits he authored (personal + oslo-kommune org).
- **slack** — messages he sent across workspaces.
- **mail** — Apple Mail messages he sent (Netcompany + Oslo kommune).
- **calendar** — Apple Calendar meetings & events (local).

Most actions are read-only. The **write** actions are `tempo log`,
`tempo set-account`, and the `jira` writes above. Every write previews the
change and confirms first (`--dry-run` to preview, `--yes` to skip the prompt)
and acts as Simon — **never write before he agrees.**

## Step 1 — always start by searching his history with Loom

`loom` is globally installed, so call it directly from anywhere. Each command
prints a JSON array of normalized events (`{ timestamp, source, type, ref,
title, body?, url? }`), so you can merge sources into one timeline.

```bash
loom tempo worklogs --since 3w --json     # what he already logged (+ his style)
loom jira issues --since 1w --json
loom jira comments --since 1w --json      # #TIL_KUNDE = customer updates
loom github prs --since 1w --json
loom github commits --since 1w --json
loom calendar events --since 1w --json    # skip Birthdays/Siri/holiday noise
loom slack messages --since 1w --json
loom mail sent --since 1w --json
```

Flags: `--since 7d|24h|2w|YYYY-MM-DD`, `--until YYYY-MM-DD`, `--json`, `--ndjson`.
Run `loom --help` to confirm what's wired up. If a connector errors (missing
token, network), say so plainly and continue with the sources that worked —
never fabricate history. Cite the events (`ref`, `url`) behind each claim.

**If Loom doesn't work, do NOT bypass it** — never call the underlying APIs
(Jira/Tempo/Atlassian REST, GitHub, Slack, ...) directly with curl/fetch or by
reading tokens from `.env`. Stop, tell the user it does not work, and give the
probable cause (read the error: expired/missing token → `loom keys` /
`loom guide <source>`, network/VPN, a Loom bug, ...). This applies doubly to
writes: Loom's preview/confirm guardrails are the whole point — a direct API
call would skip them.

Then help him with **one of two things**:

## A) Fill Tempo (Loom can write — but discuss first)

The goal is to log his hours. Loom *can* write to Tempo, but **never write
before Simon agrees.** Flow:

1. **Learn his logging style** from the **previous 3 weeks** of worklogs
   (`loom tempo worklogs --since 3w --json`): which issues he logs to, how he
   phrases descriptions, how hours are distributed across the day. Mirror that.
2. **Search what he actually did** in the target period from the other apps
   (Jira/GitHub/calendar/Slack/mail) and group it by likely Tempo issue.
3. **Ask Simon how many hours he worked each day** in the period — don't guess
   his total. Build the plan around his answer.
4. **Propose a per-day breakdown**: issue + hours + short description per entry,
   in his style. **Hard constraint: max 2.5 hours per worklog.** Split longer
   work into multiple entries (across issues, or the same issue with distinct
   descriptions) so no single entry exceeds 2.5h.
5. **Discuss and iterate** until he's happy with the breakdown.
6. **Only then write**, one entry at a time:

   ```bash
   loom tempo log --issue UKESASADF-937 --hours 2 --date 2026-06-09 \
     --description "..." --yes
   ```

   (`--issue` takes a Jira key or numeric id; `--date` defaults to today,
   `--start HH:mm` defaults to 09:00. Without `--yes` it asks to confirm.)
   Report each created worklog id back to him.

   Worklogs are booked against the issue's **Tempo Account** (billing bucket).
   If he needs to change which account an issue bills to, `loom tempo accounts
   --search <text>` finds it and `loom tempo set-account --issue K --account
   <key|id>` sets it (confirm first, same as any write).

## B) Draft his ukentlig status (read-only — he pastes it himself)

Loom has **no write access** to the weekly status, but it can **read from every
app** above. Use that to propose what to write:

- Pull the week's activity across all sources; read his recent Confluence status
  pages for tone/structure.
- **Keep it short and precise. Maximum 3–4 main bullet points, only the big
  stuff.** Clean and to-the-point — *not* a detailed activity log. Lead with
  outcomes, not tasks. Drop the noise (small DMs, routine meetings, tiny commits).
- Present the draft for him to copy in. Iterate if he wants it tighter.

## Working style

- Draft, then iterate **with** him. He decides; he applies (or approves the write).
- Show your sources so he can verify.
- For Tempo specifically: proposal → his hours-per-day → agreement → write. Never
  skip the agreement step.
