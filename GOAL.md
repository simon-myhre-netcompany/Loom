# Loom — Goal & Motivation

> Status: design / pre-implementation. This document captures *why* we're
> building Loom and *what* success looks like. It is the north star, not a
> spec.

## The problem (motivation)

As a consultant placed at a client via a consultancy, the record of what I
actually do is scattered across many systems, in many formats:

- **Weekly status** — written by hand in a Confluence page.
- **Jira tickets** — follow-up work: updating the account, deadlines,
  informing the customer through comments (the `#TIL_KUNDE` convention),
  keeping progress/estimates current.
- **Tempo (in Jira)** — time tracking. Rules: **max 2.5 hours per entry**; if I
  work longer on one task I must split it into multiple entries. Tempo must be
  submitted **monthly** (this is the client side).
- **Consultancy timereg** — the consultancy's own time
  registration. I sync Tempo hours into it (today via my **JTI** Chrome
  extension), **submit weekly**, and **close monthly**.
- **Slack & Teams** — where I communicate and inform people.
- **Git** — commits and pull requests.
- **Calendar** — meetings (Microsoft 365, but synced into Apple Calendar on my
  Mac).

All of this is *evidence of work I already did*. The information exists — it's
just trapped in silos and re-entered by hand in different shapes. That is the
waste Loom removes.

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
   (`loom tempo worklogs --since 7d`).
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
  customer-data risk low while we earn trust.
- **One source at a time.** Auth is the hard part and differs per source — some
  may be impractical. We ship value incrementally and never block on the
  hardest connector.
- **Local-first / privacy.** Data stays on my machine. We are deliberate about
  what (if anything) ever leaves it.
- **CLI now, MCP maybe later.** Plain CLIs are easy to debug and the skill calls
  them via Bash. We can wrap them in MCP if it ever pays off.

## Tech stack

- **TypeScript / Node.js** for the connectors, exposed as a single `loom`
  binary with subcommands (`loom <source> <action> [flags]`), JSON to stdout.
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
- **Consultancy timereg** — `RegisterTime`, weekly submit, monthly close. Note:
  JTI authenticates to timereg via **browser session cookies**, which does not
  translate cleanly to a headless CLI — solving timereg auth for a CLI is a
  known open problem to tackle in this phase.
- **Jira** — post `#TIL_KUNDE` comments, update estimates/deadlines/progress.
- **Confluence** — publish the weekly status draft.

Each write capability is opt-in, reviewed by me before it fires, and gated
behind explicit write credentials.

## Phase 3 — portability: Ubuntu / container (done 2026-06-10)

> Shipped: `Dockerfile` (Ubuntu 24.04, non-root, secrets never baked in) +
> `scripts/loom-docker.sh` (mounts `.env` read-only per command). All five API
> connectors verified live in the container. Calendar got a cross-platform
> **ICS feed backend** (`CALENDAR_ICS_URL*`, e.g. Outlook published-calendar
> links) instead of Graph. Mail stays macOS-only — support on Linux is
> deliberately disabled (an IMAP backend was built and then removed by
> decision; O365 tenants block IMAP basic auth anyway). Capability matrix
> in README.md.

Today Loom is developed and run on macOS. We want it to also run on **Ubuntu**
and **inside a container** — e.g. the long-lived Claude Code container, CI, or a
cron host — so the skill can fetch history without a Mac in the loop.

**What already ports cleanly (no work):** the Node runtime and every
**HTTP/API** connector — `tempo`, `jira`, `confluence`, `github`, `slack`. They
are pure `fetch` + env-var credentials, so they run anywhere Node 18+ does. This
is most of Loom's value and should work in a container as-is.

**What is macOS-only and needs a story:**

- **calendar** — reads Apple Calendar via a Swift **EventKit** helper compiled
  by `scripts/build-helper.sh`. EventKit doesn't exist on Linux; the binary
  can't build or run there.
- **mail** — reads Apple Mail via `osascript`/JXA against Mail.app. No Mail.app
  on Linux.

**Plan:**

1. **Detect platform and degrade gracefully.** On non-Darwin, the local-app
   connectors should *skip with a clear message* (not crash); `build` must still
   succeed (the helper build is a no-op off macOS). The API connectors keep
   working — `loom` stays useful in the container.
2. **Credentials stay env-var-first.** The env-var path (`.env`) is already
   cross-platform — it is the one credential mechanism on every platform.
   A container just mounts `.env`.
3. **Cross-platform substitutes for the local-app sources (optional, later).**
   Where a container truly needs calendar/mail, revisit **Microsoft Graph** for
   M365 calendar/mail behind the same `ActivityEvent` shape — acknowledging
   Graph auth is the known-painful path (see Teams in the backlog).
4. **Package it.** A small image (Node + the repo, no Swift toolchain), `loom` on
   `PATH`, `.env` mounted. Document the macOS-vs-container capability matrix so
   it's obvious which connectors are live where.

Guardrails are unchanged: read-only by default, writes still gated and confirmed
exactly as on macOS.

## Backlog (explicitly deferred)

Agreed to do later, captured so we don't lose them:

- **Microsoft Teams** — **blocked in both tenants by admin policy** (tried
  2026-06-05): can't register an Entra app (401), and Microsoft's pre-registered
  Graph CLI client is locked to assigned users + Conditional Access
  (AADSTS50105 / 53003). Needs IT to assign app access or register an app with
  delegated `Chat.Read` + admin consent. Calendar already covers the *meeting*
  side; chat would be the only addition. Note: one tenant has no Slack, only Teams.
- **Second Slack workspace** — only if another workspace ever appears (today
  there is a single Slack workspace).
- **Azure DevOps / local git** — easy PAT/zero-auth wins if code/work items live
  outside GitHub.

## Out of scope for v1

- Any **write** to any system.
- Microsoft Graph (Teams, Outlook, M365 Calendar) — Calendar comes via Apple
  Calendar instead.
- Fully automated end-to-end "fill everything" — the human stays in the loop.

## Decisions

- **Credentials:** **environment variables** (`.env`, gitignored) — the same
  mechanism on every platform.
- **Fetching:** **live, no cache** for now. Revisit if speed/offline ever hurts.

## Open questions

- Exact `type` vocabulary per source — define as each connector lands.

## Reference

- Existing tool to mine for client logic: `../JTI-github` (Chrome MV3, vanilla
  JS). Key files: `extension/utils/tempo/` (OAuth/token), `extension/api/http.js`
  (pagination), `extension/api/timereg.js`, `extension/config/mappings.js`.
