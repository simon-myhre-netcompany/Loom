/**
 * Shared Atlassian Cloud credentials. One API token serves Jira *and*
 * Confluence, so both connectors resolve auth here.
 *
 * Canonical env: ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN.
 * Backward-compatible fallback: JIRA_EMAIL / JIRA_API_TOKEN.
 */
export interface AtlassianAuth {
  email: string;
  token: string;
}

export function basicAuthHeader(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

/**
 * The Jira site URL (--base flag or JIRA_BASE_URL). Loom ships no default
 * site — every instance is configured via env.
 */
export function requireJiraBase(flags: Record<string, string | boolean>): string {
  const base =
    (typeof flags.base === 'string' ? flags.base : undefined) ?? process.env.JIRA_BASE_URL;
  if (!base) {
    throw new Error(
      'JIRA_BASE_URL is not set. Add your Jira site URL to .env, e.g. ' +
        'JIRA_BASE_URL=https://your-site.atlassian.net'
    );
  }
  return base.replace(/\/+$/, '');
}

/** Confluence base: CONFLUENCE_BASE_URL, falling back to the Jira site + /wiki. */
export function requireConfluenceBase(flags: Record<string, string | boolean>): string {
  const base =
    (typeof flags.base === 'string' ? flags.base : undefined) ?? process.env.CONFLUENCE_BASE_URL;
  return base ? base.replace(/\/+$/, '') : requireJiraBase({}) + '/wiki';
}

/** Resolve email + token from --email/--token flags, then env (canonical, then JIRA_*). */
export function resolveAtlassianAuth(
  flags: Record<string, string | boolean>
): AtlassianAuth | null {
  const email =
    (typeof flags.email === 'string' ? flags.email : undefined) ??
    process.env.ATLASSIAN_EMAIL ??
    process.env.JIRA_EMAIL;
  const token =
    (typeof flags.token === 'string' ? flags.token : undefined) ??
    process.env.ATLASSIAN_API_TOKEN ??
    process.env.JIRA_API_TOKEN;
  if (!email || !token) return null;
  return { email, token };
}
