/**
 * Connector registry. Single source of truth for what `logger` can do —
 * used both for non-interactive dispatch and to drive the interactive menu.
 */
import type { ActivityEvent } from './types.js';
import * as tempo from './connectors/tempo/index.js';

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
];

export function getConnector(source: string): ConnectorSpec | undefined {
  return CONNECTORS.find((c) => c.source === source);
}
