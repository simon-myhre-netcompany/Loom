# Logger — Goal & Motivation

> Status: design / pre-implementation. This document captures *why* we're
> building Logger and *what* success looks like. It is the north star, not a
> spec.

## The problem (motivation)

As a consultant placed at Oslo kommune via Netcompany, the record of what I
actually do is scattered across many systems, in many formats:

- **Weekly status** — written by hand in a Confluence page.
- **Jira tickets** — follow-up work: updating the account, deadlines,
  informing the customer through comments (the `#TIL_KUNDE` convention),
  keeping progress/estimates current.
- **Tempo (in Jira)** — time tracking. Rules: **max 2.5 hours per entry**; if I
  work longer on one task I must split it into multiple entries. Tempo must be
  submitted **monthly** (this is the Oslo kommune side).
- **Netcompany timereg** (`timereg.netcompany.com`) — Netcompany's own time
  registration. I sync Tempo hours into it (today via my **JTI** Chrome
  extension), **submit weekly**, and **close monthly**.
- **Slack & Teams** — where I communicate and inform people.
- **Git** — commits and pull requests.
- **Calendar** — meetings (Microsoft 365, but synced into Apple Calendar on my
  Mac).

All of this is *evidence of work I already did*. The information exists — it's
just trapped in silos and re-entered by hand in different shapes. That is the
waste Logger removes.

## The vision

I want to **chat with Claude**, have it read my recent history across these
sources, and get useful drafts and reminders, for example:

- a **draft weekly status** for Confluence,
- **which Tempo hours to fill** (and how to split them under the 2.5h rule),
- "you should **reply to customer X** on ticket ABC-123",
- "remember to **update the estimated date** on ABC-456",
- a draft `#TIL_KUNDE` comment based on what actually happened that week.

I do the actual entry **manually at first**. The tool's job in v1 is purely to
**gather and reason over my history** so I'm not the one trawling six systems.

## How we build it

A deliberate split that mirrors how Claude Code works:

1. **Connectors = small, boring CLI tools** — one per source. Each only
   **reads** and prints structured JSON. Trivial to test in isolation
   (`logger tempo worklogs --since 7d`).
2. **A `logg` skill** — knows which connectors to call, fetches recent history,
   merges it into one timeline, and reasons over it *with me* in conversation.

The intelligence lives in the skill + the conversation. The connectors stay
dumb, testable, and replaceable.

### Core contract: the normalized activity event

The thing that turns a pile of scripts into a system: **every connector emits
the same shape**, so the skill can merge everything into one timeline.

```jsonc
{
  "timestamp": "2026-06-04T13:20:00+02:00", // when it happened
  "source":    "tempo",                      // tempo | jira | git | calendar | slack | teams | confluence | timereg
  "type":      "worklog",                    // source-specific: commit | comment | transition | meeting | worklog ...
  "ref":       "ABC-123",                    // stable id: issue key, commit sha, event id ...
  "title":     "Logged 2h on ABC-123",       // one-line summary
  "body":      "...",                         // optional fuller text (comment body, commit message)
  "url":       "https://...",                // deep link back to the source, when available
  "raw":       { }                            // optional: original payload for power use
}
```

Connectors output a JSON array (or NDJSON) of these. The skill consumes the
merged stream.

### Hard principles

- **Read-only is an architectural boundary, not just discipline.** v1
  connectors have **no write code paths and no write credentials**. This keeps
  kommune/customer-data risk low while we earn trust.
- **One source at a time.** Auth is the hard part and differs per source — some
  may be impractical. We ship value incrementally and never block on the
  hardest connector.
- **Local-first / privacy.** Data stays on my machine. We are deliberate about
  what (if anything) ever leaves it.
- **CLI now, MCP maybe later.** Plain CLIs are easy to debug and the skill calls
  them via Bash. We can wrap them in MCP if it ever pays off.

## Tech stack

- **TypeScript / Node.js** for the connectors, exposed as a single `logger`
  binary with subcommands (`logger <source> <action> [flags]`), JSON to stdout.
- Rationale: the existing **JTI** extension is vanilla JS, so its Tempo / Jira /
  timereg client logic ports almost directly; one language end-to-end;
  JSON-native; easy to shell out to a small helper for Apple Calendar
  (`icalBuddy` / EventKit) instead of touching Microsoft Graph.

## Roadmap (ordered by what we'll build)

Effort/value is the real driver. We start with **Tempo** because it's the
biggest recurring pain and JTI already proved the integration.

| # | Source | Auth approach (v1, read-only) | Reuse from JTI | Notes |
|---|--------|-------------------------------|----------------|-------|
| 1 | **Tempo** | Manual personal API token (CLI-friendly) → `https://api.eu.tempo.io/4` | OAuth + manual-token paths, worklog fetch, accounts search, pagination via `metadata.next` | First. Highest pain, clean API. |
| 2 | **Git** | none (local) | — | Cheap; proves the connector→event→skill loop on a second, totally different source. |
| 3 | **Jira** | API token + email (basic auth) | `/rest/api/2/myself`, issue/comment reads | Shares auth model with Confluence. |
| 4 | **Confluence** | same Atlassian token as Jira | — | Read page history / my edits. |
| 5 | **Calendar** | local read from Apple Calendar | — | Skips MS Graph auth entirely in v1. |
| 6 | **Slack** | Slack app token | — | Needs an app; medium effort. |
| 7 | **Teams** | (deferred) | — | MS Graph perms are painful; lowest priority. |

> Within each source we follow the same loop: build the read connector → emit
> normalized events → teach the `logg` skill to use it → validate against real
> history.

## Phase 2 — write (later, explicitly out of scope for now)

Once reads are trustworthy, extend connectors to **apply** changes:

- **Tempo** — create worklogs, **including the 2.5h split logic** (net-new; JTI
  does *not* do this — it registers hours as-is, summed by day+account).
- **Netcompany timereg** — `RegisterTime`, weekly submit, monthly close. Note:
  JTI authenticates to timereg via **browser session cookies**, which does not
  translate cleanly to a headless CLI — solving timereg auth for a CLI is a
  known open problem to tackle in this phase.
- **Jira** — post `#TIL_KUNDE` comments, update estimates/deadlines/progress.
- **Confluence** — publish the weekly status draft.

Each write capability is opt-in, reviewed by me before it fires, and gated
behind explicit write credentials.

## Backlog (explicitly deferred)

Agreed to do later, captured so we don't lose them:

- **Microsoft Teams** — both the **Netcompany** and **Oslo kommune** tenants.
  Read-only chat/messages via Microsoft Graph (Azure app registration + admin
  consent; possibly metered). High friction — parked. Note: there is **no
  Netcompany Slack**, only Teams; Oslo kommune has both. Calendar already covers
  the meeting side of Teams.
- **`jira comments`** — a second Jira action to fetch issue comments, to surface
  `#TIL_KUNDE` customer-facing updates and drive follow-up reminders.
- **Second Slack workspace** — only if a non-Oslo Slack ever appears (today the
  Oslo kommune workspace is the only Slack).
- **Azure DevOps / local git** — easy PAT/zero-auth wins if code/work items live
  outside GitHub.

## Out of scope for v1

- Any **write** to any system.
- Microsoft Graph (Teams, Outlook, M365 Calendar) — Calendar comes via Apple
  Calendar instead.
- Fully automated end-to-end "fill everything" — the human stays in the loop.

## Decisions

- **Credentials:** start with **environment variables**; migrate to **macOS
  Keychain** later (Apple developer account available on this device).
- **Fetching:** **live, no cache** for now. Revisit if speed/offline ever hurts.

## Open questions

- Exact `type` vocabulary per source — define as each connector lands.

## Reference

- Existing tool to mine for client logic: `../JTI-github` (Chrome MV3, vanilla
  JS). Key files: `extension/utils/tempo/` (OAuth/token), `extension/api/http.js`
  (pagination), `extension/api/timereg.js`, `extension/config/mappings.js`.
