// Session URLs: /p/{projectId}/s/{sessionId} (plus ?session= for agents and
// external tools). Pure parse/format helpers — history wiring lives in
// init.ts so this file stays trivially testable without a DOM.

export interface AppLocation {
  projectId?: string;
  sessionId?: string;
}

/** Parse a browser location into project/session ids. `?session=` wins over
 *  the path so agents can deep-link with just an id. */
export function parseAppUrl(pathname: string, search = ""): AppLocation {
  const out: AppLocation = {};
  const m = /^\/p\/([^/]+)(?:\/s\/([^/]+))?\/?$/.exec(pathname);
  if (m) {
    out.projectId = decodeURIComponent(m[1]!);
    if (m[2]) out.sessionId = decodeURIComponent(m[2]);
  }
  const params = new URLSearchParams(search);
  const session = params.get("session");
  if (session) out.sessionId = session;
  return out;
}

/** Settings deep-link used by package OAuth callbacks (`/?settings=plugins`). */
export function settingsPageFromSearch(search = ""): string | null {
  const page = new URLSearchParams(search.startsWith("?") || search.length === 0 ? search : `?${search}`).get("settings");
  // A page may carry a bounded page-local target, for example
  // `harnesses/opencode/roles`. The settings host validates the segments and
  // routes the target to the owning page.
  if (!page || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){0,2}$/i.test(page)) return null;
  return page;
}

let bootSettingsLink: { page: string; code: string | null } | null = null;

/** Remember a settings deep link at boot. The first URL canonicalization drops
 *  the query (`/?settings=apps&code=…` becomes `/p/<project>`) before packages
 *  have loaded and before the page that reads the code has mounted. */
export function rememberBootSettingsLink(search: string): void {
  const page = settingsPageFromSearch(search);
  if (!page) return;
  bootSettingsLink = { page, code: new URLSearchParams(search).get("code") };
}

/** The settings page a boot link asked for. Read once. */
export function takeBootSettingsPage(): string | null {
  const page = bootSettingsLink?.page ?? null;
  if (bootSettingsLink) bootSettingsLink = { page: "", code: bootSettingsLink.code };
  return page || null;
}

/** The sign-in code a boot link carried. Read once, by the page confirming it. */
export function takeBootSettingsCode(): string | null {
  const code = bootSettingsLink?.code ?? null;
  if (bootSettingsLink) bootSettingsLink = { ...bootSettingsLink, code: null };
  return code;
}

/** Canonical URL for the current selection ("/" when nothing is active). */
export function formatAppUrl(projectId: string | null, sessionId: string | null): string {
  if (!projectId) return sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
  const base = `/p/${encodeURIComponent(projectId)}`;
  return sessionId ? `${base}/s/${encodeURIComponent(sessionId)}` : base;
}
