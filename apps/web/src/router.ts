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

/** Canonical URL for the current selection ("/" when nothing is active). */
export function formatAppUrl(projectId: string | null, sessionId: string | null): string {
  if (!projectId) return "/";
  const base = `/p/${encodeURIComponent(projectId)}`;
  return sessionId ? `${base}/s/${encodeURIComponent(sessionId)}` : base;
}
