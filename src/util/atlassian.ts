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
