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

/** Install links into Settings → Packages, as the package catalog
 *  (packages.polyth.app) builds them:
 *  - `?settings=packages&package=<id>` lands on one package's row;
 *  - `?settings=packages&install=<source>` opens Add package with the link
 *    prefilled.
 *  Both only navigate: the person still turns the package on, or reviews and
 *  confirms the install. Values are bounded here; the installer decides which
 *  sources it accepts. */
export interface PackagesLink {
  packageId?: string;
  installSource?: string;
}
export const PACKAGES_LINK_PARAMS = ["package", "install"] as const;
const MAX_INSTALL_SOURCE = 2048;

export function packagesLinkFromSearch(search = ""): PackagesLink | null {
  const params = new URLSearchParams(search.startsWith("?") || search.length === 0 ? search : `?${search}`);
  if (params.get("settings") !== "packages") return null;
  const packageId = params.get("package") ?? "";
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(packageId)) return { packageId };
  const source = (params.get("install") ?? "").trim();
  // eslint-disable-next-line no-control-regex
  if (source && source.length <= MAX_INSTALL_SOURCE && !/[\u0000-\u001f\u007f\s]/.test(source)) return { installSource: source };
  return null;
}

/** Canonical URL for the current selection ("/" when nothing is active). */
export function formatAppUrl(projectId: string | null, sessionId: string | null): string {
  if (!projectId) return sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
  const base = `/p/${encodeURIComponent(projectId)}`;
  return sessionId ? `${base}/s/${encodeURIComponent(sessionId)}` : base;
}
