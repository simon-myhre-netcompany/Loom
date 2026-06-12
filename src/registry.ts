/**
 * Connector registry. Single source of truth for what `loom` can do —
 * used both for non-interactive dispatch and to drive the interactive menu.
 */
import type { ActivityEvent } from './types.js';
import * as tempo from './connectors/tempo/index.js';
import * as github from './connectors/github/index.js';
import * as calendar from './connectors/calendar/index.js';
import * as jira from './connectors/jira/index.js';
import * as confluence from './connectors/confluence/index.js';
import * as slack from './connectors/slack/index.js';
import * as mail from './connectors/mail/index.js';

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

/** How to obtain a credential — shown by `loom guide`. */
export interface CredentialGuide {
  env: string;
  required: boolean;
  steps: string[];
}

/** Whether a connector can run right now, and why/why not (for `loom status`). */
export interface Availability {
  state: 'ready' | 'unconfigured' | 'disabled';
  detail: string;
}

export interface ConnectorSpec {
  source: string;
  description: string;
  run: (action: string | undefined, argv: string[]) => Promise<ActivityEvent[]>;
  actions: ActionSpec[];
  /** Step-by-step instructions for getting each credential this connector needs. */
  setup: CredentialGuide[];
  /** Env/platform check — never touches the network. */
  availability: () => Availability;
}

const envSet = (...names: string[]): string[] => names.filter((n) => !process.env[n]);

/** True when VAR or any VAR_<SUFFIX> is set (the multi-account pattern). */
const envFamily = (prefix: string): boolean =>
  Object.entries(process.env).some(
    ([k, v]) => !!v && (k === prefix || k.startsWith(`${prefix}_`))
  );

const need = (...names: string[]): Availability => {
  const missing = envSet(...names);
  return missing.length === 0
    ? { state: 'ready', detail: 'credentials present' }
    : { state: 'unconfigured', detail: `set ${missing.join(', ')} in .env` };
};

const atlassian = (): Availability => {
  const missing = [
    ...(process.env.ATLASSIAN_EMAIL ?? process.env.JIRA_EMAIL ? [] : ['ATLASSIAN_EMAIL']),
    ...(process.env.ATLASSIAN_API_TOKEN ?? process.env.JIRA_API_TOKEN ? [] : ['ATLASSIAN_API_TOKEN']),
    ...(process.env.JIRA_BASE_URL ? [] : ['JIRA_BASE_URL']),
  ];
  return missing.length === 0
    ? { state: 'ready', detail: 'credentials present' }
    : { state: 'unconfigured', detail: `set ${missing.join(', ')} in .env` };
};

export const CONNECTORS: ConnectorSpec[] = [
  {
    source: 'tempo',
    availability: () => need('TEMPO_API_TOKEN'),
    description: 'Tempo worklogs (read) + log time and set an issue\'s Account (write)',
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
      {
        name: 'log',
        description: 'Create a worklog (write — needs an account id; confirms first)',
        prompts: [
          { key: 'issue', label: 'Issue key or numeric id (e.g. TIL-123)' },
          { key: 'hours', label: 'Hours spent (e.g. 1.5)' },
          { key: 'date', label: 'Work date (YYYY-MM-DD, blank = today)', prompt: false },
          { key: 'description', label: 'Description (blank = issue summary)', prompt: false },
        ],
      },
      {
        name: 'accounts',
        description: 'List Tempo accounts (billing buckets); --search to filter, --all for closed',
        prompts: [
          { key: 'search', label: 'Filter by key/name (blank = all open)', prompt: false },
        ],
      },
      {
        name: 'set-account',
        description: 'WRITE: set an issue\'s Tempo Account (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'issue', label: 'Issue key (e.g. SOT-169)' },
          { key: 'account', label: 'Account key, numeric id, or "none" to clear' },
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
          'Name it "LOOM" and set Expiration to 365 days.',
          'Choose "Custom" access and grant VIEW on all scopes:',
          '  Accounts, Activities, Approvals, Audit, Periods, Plans,',
          '  Projects, Schemes, Teams, Worklogs.',
          'For `loom tempo log` (writing time), ALSO grant MANAGE on Worklogs',
          '  — that is the only write scope Loom uses. Leave everything else',
          '  VIEW-only so the token can never write beyond worklogs.',
          'Confirm, copy the token, and set TEMPO_API_TOKEN in .env.',
          'Register its expiry so `loom keys check` can warn you:',
          '  loom keys add --env TEMPO_API_TOKEN --expires <365-days-out> \\',
          '    --label "Tempo API token (LOOM)" --source tempo',
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
          'Without it, Loom fetches every worklog the token can see',
          '(the whole org) instead of just yours — so set it.',
          'It is also REQUIRED for `loom tempo log`: writing refuses to run',
          'without it, so a worklog can only ever be created under your account.',
        ],
      },
    ],
  },
  {
    source: 'github',
    availability: () => envFamily('GITHUB_TOKEN')
      ? { state: 'ready', detail: 'credentials present' }
      : { state: 'unconfigured', detail: 'set GITHUB_TOKEN_<NAME> in .env' },
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
          'Token name: LOOM. Resource owner: your personal account.',
          'Repository access: All repositories (or just the ones you want logged).',
          'Permissions — Add permissions, set all of these to READ:',
          '  Contents, Discussions, Issues, Metadata, Pull requests.',
          'Generate, copy, set GITHUB_TOKEN_PERSONAL in .env, then register:',
          '  loom keys add --env GITHUB_TOKEN_PERSONAL --expires <date> \\',
          '    --label "GitHub PAT (personal)" --source github',
        ],
      },
      {
        env: 'GITHUB_TOKEN_<ORG>',
        required: false,
        steps: [
          'A SECOND fine-grained PAT per organization you work in, so it can',
          '  see the org repos (a fine-grained PAT is locked to one owner).',
          'Same flow as above, but set Resource owner to the organization.',
          'Repository access: All repositories.',
          'Permissions — Add permissions, set all of these to READ:',
          '  Contents, Discussions, Issues, Metadata, Pull requests.',
          'Note: org tokens may need an admin to approve them before they work.',
          '',
          'Add as many as you like: Loom reads EVERY GITHUB_TOKEN /',
          'GITHUB_TOKEN_<NAME> var (any suffix) and merges the results.',
          'Two ways to add one:',
          '  .env:  add a line  GITHUB_TOKEN_WORK=github_pat_...',
          '  CLI:   loom keys add --env GITHUB_TOKEN_WORK --expires <date>',
          '         — prompts for the secret (hidden) and writes .env for you;',
          '         from a script: pipe it with --value-stdin.',
        ],
      },
    ],
  },
  {
    source: 'calendar',
    availability: () => calendar.availability(),
    description: 'Calendar events (macOS: Apple Calendar/EventKit; Linux: ICS feed URLs)',
    run: calendar.run,
    actions: [
      {
        name: 'events',
        description: 'Meetings & events in the range from all your calendars',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
          { key: 'ics', label: 'Force the ICS backend? (--ics)', prompt: false },
        ],
      },
    ],
    setup: [
      {
        env: '(macOS: no API key — all local)',
        required: true,
        steps: [
          'On macOS, Apple Calendar is read locally via EventKit. No tokens.',
          '',
          '1. Get your calendars INTO Apple Calendar (Calendar.app):',
          '   System Settings → Internet Accounts → Add Account.',
          '   Add each work/personal account (Microsoft Exchange / 365, ...).',
          '   Enable "Calendars" for each account. They now sync into Calendar.app.',
          '',
          '2. Build the helper (needs Xcode command line tools / swiftc):',
          '   npm run build      # compiles bin/calendar-helper',
          '',
          '3. Grant Calendar permission (one time):',
          '   Run `loom calendar events` once. macOS prompts for Calendar',
          '   access — allow it. If no prompt appears, go to System Settings →',
          '   Privacy & Security → Calendars and enable your terminal app.',
          '',
          'That is it — then `loom calendar events --since 14d` works.',
        ],
      },
      {
        env: 'CALENDAR_ICS_URL',
        required: false,
        steps: [
          'Linux / container backend: one or more iCalendar (.ics) feed URLs.',
          'EventKit does not exist off macOS, so there Loom reads published',
          'calendar links instead (same `loom calendar events` command).',
          '',
          '1. Publish your Outlook/M365 calendar:',
          '   Outlook on the web → Settings (gear) → Calendar →',
          '   Shared calendars → "Publish a calendar".',
          '   Pick the calendar, permission "Can view all details", Publish.',
          '   Copy the ICS link.',
          '2. Set it in .env as CALENDAR_ICS_URL. More calendars: add',
          '   CALENDAR_ICS_URL_<NAME> vars (e.g. CALENDAR_ICS_URL_WORK)',
          '   — Loom reads and merges them all.',
          '   A local .ics file path also works (offline exports/tests).',
          '',
          'SECURITY: the published URL is a capability URL — anyone holding it',
          'can read the calendar. Treat it exactly like an API token: only in',
          '.env, never committed, never pasted into chats/tickets. Unpublish',
          'in Outlook to revoke it.',
          '',
          'On macOS the EventKit helper wins when built; pass --ics to force',
          'the feed backend (e.g. to test what the container will see).',
        ],
      },
    ],
  },
  {
    source: 'jira',
    availability: () => atlassian(),
    description: 'Jira issues you work on (read) + guarded writes (comment, status, ...)',
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
      {
        name: 'comments',
        description: 'Comments on your issues (yours tagged #TIL_KUNDE; --all for everyone)',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'key', label: 'Specific issue key(s)? (comma-sep, blank = your recent issues)', prompt: false },
          { key: 'all', label: "Include everyone's comments? (with --key: the whole thread)", prompt: false },
        ],
      },
      {
        name: 'comment',
        description: 'WRITE: post a comment on an issue (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'body', label: 'Comment text' },
        ],
      },
      {
        name: 'transition',
        description: 'WRITE: change an issue\'s status (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'to', label: 'Target status (e.g. "In Progress", "Done")' },
          { key: 'resolution', label: 'Resolution if resolving (e.g. Fixed; blank to skip)', prompt: false },
          { key: 'field', label: 'Screen field "Name=value" (e.g. "Løsningsmetode=...")', prompt: false },
        ],
      },
      {
        name: 'describe',
        description: 'WRITE: replace an issue\'s description (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'body', label: 'New description' },
        ],
      },
      {
        name: 'estimate',
        description: 'WRITE: set original/remaining time estimate (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'original', label: 'Original estimate (e.g. 3h, 1d 4h; blank to skip)', prompt: false },
          { key: 'remaining', label: 'Remaining estimate (e.g. 2h; blank to skip)', prompt: false },
        ],
      },
      {
        name: 'assign',
        description: 'WRITE: set the assignee (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'to', label: 'Assignee (name, email, "me", or "none")' },
        ],
      },
      {
        name: 'rename',
        description: 'WRITE: change the summary/title (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'to', label: 'New summary' },
        ],
      },
      {
        name: 'labels',
        description: 'WRITE: add/remove labels (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'add', label: 'Labels to add (comma-sep; blank to skip)', prompt: false },
          { key: 'remove', label: 'Labels to remove (comma-sep; blank to skip)', prompt: false },
        ],
      },
      {
        name: 'set',
        description: 'WRITE: set priority and/or due date (confirms; --dry-run/--yes)',
        prompts: [
          { key: 'key', label: 'Issue key (e.g. SOT-169)' },
          { key: 'priority', label: 'Priority (e.g. High; blank to skip)', prompt: false },
          { key: 'due', label: 'Due date YYYY-MM-DD (blank to skip)', prompt: false },
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
          'Name: LOOM. Set an expiry (e.g. 365 days).',
          'Copy the token and set ATLASSIAN_API_TOKEN in .env, then register:',
          '  loom keys add --env ATLASSIAN_API_TOKEN --expires <date> \\',
          '    --label "Atlassian API token (LOOM)" --source atlassian',
          'The same token also authorizes the guarded write actions (comment,',
          '  transition, describe, estimate) — they act AS you, limited to what',
          '  your Jira account is allowed to do.',
        ],
      },
      {
        env: 'ATLASSIAN_EMAIL',
        required: true,
        steps: [
          'The email of your Atlassian account (the Basic-auth username).',
          'Set ATLASSIAN_EMAIL in .env.',
        ],
      },
      {
        env: 'JIRA_BASE_URL',
        required: true,
        steps: [
          'Your Jira site URL, e.g. https://your-site.atlassian.net.',
          'Required — Loom ships no default site. Set JIRA_BASE_URL in .env.',
        ],
      },
    ],
  },
  {
    source: 'confluence',
    availability: () => atlassian(),
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
          '  you are already done. See `loom guide jira`.',
          'Needs ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN in .env.',
          'Optional: CONFLUENCE_BASE_URL (defaults to JIRA_BASE_URL + /wiki).',
        ],
      },
    ],
  },
  {
    source: 'slack',
    availability: () => envFamily('SLACK_TOKEN')
      ? { state: 'ready', detail: 'credentials present' }
      : { state: 'unconfigured', detail: 'set SLACK_TOKEN_<WORKSPACE> in .env' },
    description: 'Slack messages — yours, a channel\'s, or any search (across workspaces)',
    run: slack.run,
    actions: [
      {
        name: 'messages',
        description:
          'Search messages (default: yours; --channel/--from/--query search anything you can see)',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
          { key: 'channel', label: 'Limit to a channel? (name, blank = all)', prompt: false },
          { key: 'from', label: 'From whom? (@user / me, blank = anyone)', prompt: false },
          { key: 'query', label: 'Free-text search? (blank = none)', prompt: false },
        ],
      },
      {
        name: 'history',
        description:
          'Every message in one channel, exact time window, bot posts included ' +
          '(needs channels:read + channels:history scopes)',
        prompts: [
          { key: 'channel', label: 'Which channel? (name or id)' },
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
          '   Name it LOOM and pick the workspace.',
          '   (NOT "generate token" — that is for app-config, not what we want.)',
          '2. Left sidebar → "OAuth & Permissions".',
          '3. Under "User Token Scopes" (NOT Bot), add:',
          '     search:read   (search messages: yours, a channel, free text)',
          '     users:read    (resolve your identity)',
          '   and, only if you want `slack history` (walk a full channel,',
          '   bot posts included):',
          '     channels:read + channels:history   (public channels)',
          '     groups:read   + groups:history     (private channels)',
          '4. Top of the page → "Install to Workspace".',
          '   - "Allow" screen  → you can self-serve. Click Allow.',
          '   - "Request to Install" → needs an admin; ask IT or try another',
          '     workspace where you can self-serve.',
          '5. Copy the "User OAuth Token" (starts with xoxp-).',
          '6. Store it as SLACK_TOKEN_<WORKSPACE> — any suffix, one per',
          '   workspace, as many as you like; Loom reads every SLACK_TOKEN /',
          '   SLACK_TOKEN_* var and merges the workspaces. Two ways:',
          '     .env:  add a line  SLACK_TOKEN_WORK=xoxp-...',
          '     CLI:   loom keys add --env SLACK_TOKEN_WORK --expires never',
          '            — prompts for the secret (hidden) and writes .env;',
          '            from a script: pipe it with --value-stdin.',
          '',
          'Note: search.messages must be enabled for the workspace (it is on most',
          'paid plans). The connector will error with a clear message if not.',
        ],
      },
    ],
  },
  {
    source: 'mail',
    availability: () => mail.availability(),
    description: 'Apple Mail messages (macOS-only — disabled on Linux)',
    run: mail.run,
    actions: [
      {
        name: 'sent',
        description: 'Emails you sent in the range (from Mail.app Sent folders)',
        prompts: [
          { key: 'since', label: 'Look back how far? (e.g. 7d, 2w, YYYY-MM-DD)', default: '7d' },
          { key: 'until', label: 'Up until? (YYYY-MM-DD, blank = today)', prompt: false },
        ],
      },
      {
        name: 'inbox',
        description: 'Emails you received in the range (from Mail.app inboxes)',
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
          'Apple Mail is read locally via Mail.app scripting. No tokens.',
          '',
          '1. Add your accounts to Apple Mail (Mail.app):',
          '   System Settings → Internet Accounts → add your mail accounts',
          '   (Microsoft Exchange / 365, ...). Enable "Mail".',
          '',
          '2. Grant Automation permission (one time):',
          '   Run `loom mail sent` once. macOS prompts "<terminal> wants to',
          '   control Mail" — click OK. If no prompt, enable it under System',
          '   Settings → Privacy & Security → Automation → your terminal → Mail.',
          '',
          'Then `loom mail sent --since 14d` lists the emails you sent.',
          'Note: reads your Sent folders (Sent / Sendte elementer) across',
          'all accounts and merges them.',
        ],
      },
      {
        env: '(Linux: disabled)',
        required: false,
        steps: [
          'Mail support is DISABLED on Ubuntu/Linux/containers — by decision.',
          'On those platforms `loom mail` exits with a clear message; every',
          'other source still works there. Run mail reads on the Mac.',
        ],
      },
    ],
  },
];

export function getConnector(source: string): ConnectorSpec | undefined {
  return CONNECTORS.find((c) => c.source === source);
}
