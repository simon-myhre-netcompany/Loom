/**
 * Connector registry. Single source of truth for what `logger` can do —
 * used both for non-interactive dispatch and to drive the interactive menu.
 */
import type { ActivityEvent } from './types.js';
import * as tempo from './connectors/tempo/index.js';
import * as github from './connectors/github/index.js';
import * as calendar from './connectors/calendar/index.js';
import * as jira from './connectors/jira/index.js';
import * as confluence from './connectors/confluence/index.js';
import * as slack from './connectors/slack/index.js';

/** A flag an action accepts, with metadata for prompting in interactive mode. */
export interface PromptSpec {
  /** Flag name (without --) and the key prompted for. */
  key: string;
  label: string;
  default?: string;
  /** If false, skip prompting in interactive mode (advanced/optional). */
  prompt?: boolean;
}

export interface ActionSpec {
  name: string;
  description: string;
  prompts: PromptSpec[];
}

/** How to obtain a credential — shown by `logger guide`. */
export interface CredentialGuide {
  env: string;
  required: boolean;
  steps: string[];
}

export interface ConnectorSpec {
  source: string;
  description: string;
  run: (action: string | undefined, argv: string[]) => Promise<ActivityEvent[]>;
  actions: ActionSpec[];
  /** Step-by-step instructions for getting each credential this connector needs. */
  setup: CredentialGuide[];
}

export const CONNECTORS: ConnectorSpec[] = [
  {
    source: 'tempo',
    description: 'Tempo worklogs — your logged hours',
    run: tempo.run,
    actions: [
      {
        name: 'worklogs',
        description: 'Fetch logged hours as activity events',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: 'TEMPO_API_TOKEN',
        required: true,
        steps: [
          'In Jira, open Apps → Tempo → Settings.',
          'Go to "API Integration" → "New Token".',
          'Name it "LOGGER" and set Expiration to 365 days.',
          'Choose "Custom" access and grant VIEW on all scopes:',
          '  Accounts, Activities, Approvals, Audit, Periods, Plans,',
          '  Projects, Schemes, Teams, Worklogs.',
          'Confirm, copy the token, and set TEMPO_API_TOKEN in .env.',
          'Register its expiry so `logger keys check` can warn you:',
          '  logger keys add --env TEMPO_API_TOKEN --expires <365-days-out> \\',
          '    --label "Tempo API token (LOGGER)" --source tempo',
        ],
      },
      {
        env: 'TEMPO_ACCOUNT_ID',
        required: false,
        steps: [
          'In Jira, click your profile picture → Profile.',
          'Ask Rovo AI: "what\'s my account id".',
          'Copy the accountId (looks like 712020:xxxxxxxx-...) into',
          '  TEMPO_ACCOUNT_ID in .env.',
          'Without it, Logger fetches every worklog the token can see',
          '(the whole org) instead of just yours — so set it.',
        ],
      },
    ],
  },
  {
    source: 'github',
    description: 'GitHub PRs & commits you authored (across accounts/orgs)',
    run: github.run,
    actions: [
      {
        name: 'prs',
        description: 'Pull requests you authored, with activity in the range',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
        ],
      },
      {
        name: 'commits',
        description: 'Commits you authored (default branches) in the range',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: 'GITHUB_TOKEN_PERSONAL',
        required: true,
        steps: [
          'A fine-grained PAT is locked to ONE resource owner, so make one per',
          'account/org. This one is for your PERSONAL repos:',
          'GitHub → profile picture → Settings → Developer settings →',
          '  Personal access tokens → Fine-grained tokens → Generate new token.',
          'Token name: LOGGER. Resource owner: your personal account.',
          'Repository access: All repositories (or just the ones you want logged).',
          'Permissions — Add permissions, set all of these to READ:',
          '  Contents, Discussions, Issues, Metadata, Pull requests.',
          'Generate, copy, set GITHUB_TOKEN_PERSONAL in .env, then register:',
          '  logger keys add --env GITHUB_TOKEN_PERSONAL --expires <date> \\',
          '    --label "GitHub PAT (personal)" --source github',
        ],
      },
      {
        env: 'GITHUB_TOKEN_OSLO',
        required: false,
        steps: [
          'A SECOND fine-grained PAT, Resource owner = Oslo kommune org, so it',
          '  can see the org repos you work on.',
          'Go to https://github.com/oslokommune-uke → profile picture →',
          '  Settings → Developer settings → Personal access tokens →',
          '  Fine-grained tokens → Generate new token (log in if prompted).',
          'Token name: LOGGER. Resource owner: Oslo kommune.',
          'Repository access: All repositories.',
          'Permissions — Add permissions, set all of these to READ:',
          '  Contents, Discussions, Issues, Metadata, Pull requests.',
          'Note: org tokens may need an admin to approve them before they work.',
          'Set GITHUB_TOKEN_OSLO in .env and register its expiry as above.',
          'Logger reads every GITHUB_TOKEN / GITHUB_TOKEN_* var and merges them,',
          'so add as many orgs as you like with more GITHUB_TOKEN_<NAME> vars.',
        ],
      },
    ],
  },
  {
    source: 'calendar',
    description: 'Apple Calendar events (local, via EventKit — no API keys)',
    run: calendar.run,
    actions: [
      {
        name: 'events',
        description: 'Meetings & events in the range from all your calendars',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: '(no API key — all local)',
        required: true,
        steps: [
          'Apple Calendar is read locally via EventKit. No tokens, no cloud auth.',
          '',
          '1. Get your calendars INTO Apple Calendar (Calendar.app):',
          '   System Settings → Internet Accounts → Add Account.',
          '   - Netcompany mail/calendar: add it (Microsoft Exchange / 365).',
          '   - Oslo kommune mail/calendar: add it (Microsoft Exchange / 365).',
          '   Enable "Calendars" for each account. They now sync into Calendar.app.',
          '',
          '2. Build the helper (needs Xcode command line tools / swiftc):',
          '   npm run build      # compiles bin/calendar-helper',
          '',
          '3. Grant Calendar permission (one time):',
          '   Run `logger calendar events` once. macOS prompts for Calendar',
          '   access — allow it. If no prompt appears, go to System Settings →',
          '   Privacy & Security → Calendars and enable your terminal app.',
          '',
          'That is it — then `logger calendar events --since 14d` works.',
        ],
      },
    ],
  },
  {
    source: 'jira',
    description: 'Jira issues you work on (assignee / worklog author)',
    run: jira.run,
    actions: [
      {
        name: 'issues',
        description: 'Issues updated in the range that you are involved in',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'jql', label: 'Custom JQL? (blank = your recent issues)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: 'ATLASSIAN_API_TOKEN',
        required: true,
        steps: [
          'One Atlassian API token serves BOTH Jira and Confluence (Basic auth',
          '  with your email).',
          'Go to https://id.atlassian.com/manage-profile/security/api-tokens',
          '  → "Create API token".',
          'Name: LOGGER. Set an expiry (e.g. 365 days).',
          'Copy the token and set ATLASSIAN_API_TOKEN in .env, then register:',
          '  logger keys add --env ATLASSIAN_API_TOKEN --expires <date> \\',
          '    --label "Atlassian API token (LOGGER)" --source atlassian',
        ],
      },
      {
        env: 'ATLASSIAN_EMAIL',
        required: true,
        steps: [
          'The email of your Atlassian account (the Basic-auth username).',
          'For Oslo kommune that is simon.myhre@drift.oslo.kommune.no.',
          'Set ATLASSIAN_EMAIL in .env.',
        ],
      },
      {
        env: 'JIRA_BASE_URL',
        required: false,
        steps: [
          'Your Jira site URL. Defaults to https://oslo-kommune.atlassian.net,',
          'so you only need to set JIRA_BASE_URL for a different site.',
        ],
      },
    ],
  },
  {
    source: 'confluence',
    description: 'Confluence pages you edited (weekly status, recent edits)',
    run: confluence.run,
    actions: [
      {
        name: 'pages',
        description: 'Pages/blogposts you contributed to, modified in the range',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 30d, 2w, YYYY-MM-DD)', default: '30d' },
          { key: 'cql', label: 'Custom CQL? (blank = your recent pages)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: 'ATLASSIAN_API_TOKEN',
        required: true,
        steps: [
          'Confluence uses the SAME Atlassian token as Jira — if you set up Jira,',
          '  you are already done. See `logger guide jira`.',
          'Needs ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in .env.',
          'Optional: CONFLUENCE_BASE_URL (defaults to',
          '  https://oslo-kommune.atlassian.net/wiki).',
        ],
      },
    ],
  },
  {
    source: 'slack',
    description: 'Slack messages you sent (across workspaces)',
    run: slack.run,
    actions: [
      {
        name: 'messages',
        description: 'Messages you sent in the range (search.messages from:me)',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: 'SLACK_TOKEN_<WORKSPACE>',
        required: true,
        steps: [
          'A Slack USER token (xoxp-) per workspace. One app per workspace:',
          '',
          '1. Go to https://api.slack.com/apps → "Create New App" → "From scratch".',
          '   Name it LOGGER and pick the workspace.',
          '   (NOT "generate token" — that is for app-config, not what we want.)',
          '2. Left sidebar → "OAuth & Permissions".',
          '3. Under "User Token Scopes" (NOT Bot), add:',
          '     search:read   (find your messages)',
          '     users:read    (resolve your identity)',
          '4. Top of the page → "Install to Workspace".',
          '   - "Allow" screen  → you can self-serve. Click Allow.',
          '   - "Request to Install" → needs an admin; ask IT or try another',
          '     workspace where you can self-serve.',
          '5. Copy the "User OAuth Token" (starts with xoxp-).',
          '6. Set it in .env as SLACK_TOKEN_OSLO (or _NETCOMPANY, etc.) — Logger',
          '   reads every SLACK_TOKEN / SLACK_TOKEN_* var and merges workspaces.',
          '',
          'Note: search.messages must be enabled for the workspace (it is on most',
          'paid plans). The connector will error with a clear message if not.',
        ],
      },
    ],
  },
];

export function getConnector(source: string): ConnectorSpec | undefined {
  return CONNECTORS.find((c) => c.source === source);
}
