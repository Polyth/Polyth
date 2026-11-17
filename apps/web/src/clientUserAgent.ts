// Which shell signed in: the account device list is built from the sign-in
// request's User-Agent plus the token an app appends to it. A phone app and
// phone Safari ship the same WebKit agent, and an Electron window reports a
// plain Chrome agent, so the token is the only way to tell them apart.
//
//   desktop app          … Chrome/156.0.0.0 Safari/537.36 PolythDesktop/1.2.0
//   workstation build    … PolythDesktop-Workstation/1.2.0
//   phone app            … Mobile/15E148 PolythMobile
//
// Both tokens are optional and unaudited client claims: render them, never
// authorize on them. Parsing only — the caller translates with its own catalog.

export type ShellKind = "desktop" | "desktop-workstation" | "mobile";
export interface ShellInfo { kind: ShellKind; version: string | null }

export type BrowserName = "edge" | "firefox" | "chrome" | "safari";
export type OsName = "windows" | "macos" | "android" | "ios" | "linux";

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A token is a whole space-separated field, optionally carrying `/version`. */
const shellToken = (ua: string, name: string): { found: boolean; version: string | null } => {
  const match = new RegExp(`(?:^|[\\s(])${escaped(name)}(?:/([\\w.+-]{1,40}))?(?:$|[\\s;)])`).exec(ua);
  return match ? { found: true, version: match[1] ?? null } : { found: false, version: null };
};

export function shellOf(userAgent: string): ShellInfo | null {
  if (!userAgent) return null;
  // The workstation name starts with the standard one: check it first.
  const workstation = shellToken(userAgent, "PolythDesktop-Workstation");
  if (workstation.found) return { kind: "desktop-workstation", version: workstation.version };
  const desktop = shellToken(userAgent, "PolythDesktop");
  if (desktop.found) return { kind: "desktop", version: desktop.version };
  const mobile = shellToken(userAgent, "PolythMobile");
  if (mobile.found) return { kind: "mobile", version: mobile.version };
  return null;
}

export function browserOf(userAgent: string): BrowserName | null {
  if (/Edg\//.test(userAgent)) return "edge";
  if (/Firefox\//.test(userAgent)) return "firefox";
  if (/Chrome\//.test(userAgent)) return "chrome";
  if (/Safari\//.test(userAgent)) return "safari";
  return null;
}

export function osOf(userAgent: string): OsName | null {
  if (/Windows/.test(userAgent)) return "windows";
  // An iPad reports "Macintosh" inside the mac branch, so phones come first.
  if (/iPhone|iPad/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macos";
  if (/Linux/.test(userAgent)) return "linux";
  return null;
}

/** A phone-shaped device: the phone app, a phone browser, or a phone WebView. */
export function isPhoneAgent(userAgent: string): boolean {
  return shellOf(userAgent)?.kind === "mobile" || /iPhone|Android.+Mobile|Mobile Safari/.test(userAgent);
}
