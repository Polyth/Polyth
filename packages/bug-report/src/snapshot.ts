// What the report sheet adds to a nightly bug report from the page: an
// allowlist of interface settings, what the window showed, the viewport and
// the tab's recent error notices. Allowlists, never denylists: a setting
// that is not named here never leaves the computer, whatever it holds.
// Pure and browser-safe, so it is unit-tested without a DOM.

import {
  BUG_REPORT_LIMITS,
  type BugReportError,
  type BugReportPackage,
  type BugReportSettingValue,
  type BugReportWeb,
} from "@polyth/contracts/bug-report";

/** Interface settings worth knowing to reproduce a layout or theme bug.
 *  Free text the person wrote (product name, prompts, branch templates) is
 *  deliberately absent. */
export const UI_SETTING_KEYS = [
  "theme",
  "appearanceMode",
  "themeStyle",
  "accentColor",
  "density",
  "fontSize",
  "chatFontSize",
  "fontFamily",
  "relativeTime",
  "sendOnEnter",
  "desktopSendShortcut",
  "compactionDefault",
  "showArchived",
  "defaultVisibleSessionCount",
  "defaultModel",
] as const;

/** Root `data-*` flags the shell sets for look and input mode. */
export const ROOT_FLAGS = ["appearance", "reduceAnimations", "inputModality", "locale", "desktopApp"] as const;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const TOKEN = /^[A-Za-z0-9_-]{1,40}$/;

function settingValue(value: unknown): BugReportSettingValue | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.length <= BUG_REPORT_LIMITS.settingValueChars && !CONTROL.test(value)) return value;
  return undefined;
}

export interface PageFacts {
  /** `document.documentElement.dataset`. */
  rootFlags: Readonly<Record<string, string | undefined>>;
  prefersReducedMotion: boolean;
  prefersDark: boolean;
  /** `navigator.language`. */
  language: string;
}

/** `ui.*` settings: the allowlisted shell settings plus page facts. */
export function uiSettings(settings: Readonly<Record<string, unknown>>, page: PageFacts): Record<string, BugReportSettingValue> {
  const out: Record<string, BugReportSettingValue> = {};
  for (const key of UI_SETTING_KEYS) {
    const value = settingValue(settings[key]);
    if (value !== undefined) out[`ui.${key}`] = value;
  }
  for (const flag of ROOT_FLAGS) {
    const value = page.rootFlags[flag];
    if (typeof value === "string" && TOKEN.test(value)) out[`ui.root.${flag}`] = value;
  }
  out["ui.prefersReducedMotion"] = page.prefersReducedMotion;
  out["ui.prefersDark"] = page.prefersDark;
  const language = page.language.replace(/[^A-Za-z0-9-]/g, "").slice(0, 35);
  if (language) out["ui.language"] = language;
  return out;
}

export interface ViewFacts {
  activeView: string;
  overlay: string | null;
  activePage?: { pageId: string } | null;
}

/** A view or page id: never a session, project or resource. */
export function viewName(facts: ViewFacts): string {
  const raw = facts.overlay ? `overlay:${facts.overlay}`
    : facts.activePage?.pageId ? `page:${facts.activePage.pageId}`
      : facts.activeView;
  return raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
}

export function viewport(width: number, height: number, devicePixelRatio: number): BugReportWeb["viewport"] {
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
  const scale = Number.isFinite(devicePixelRatio) ? Math.min(8, Math.max(0.25, Math.round(devicePixelRatio * 100) / 100)) : 1;
  return { width: clamp(width, 20_000), height: clamp(height, 20_000), scale };
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,5}(?:-nightly)?$/;
const BUILD = /^[A-Za-z0-9._-]{0,64}$/;

export function webFacts(input: { build: unknown; serverVersion: unknown; view: string; viewport: BugReportWeb["viewport"] }): BugReportWeb {
  return {
    build: typeof input.build === "string" && BUILD.test(input.build) ? input.build : "",
    serverVersion: typeof input.serverVersion === "string" && VERSION.test(input.serverVersion) ? input.serverVersion : "",
    view: input.view,
    viewport: input.viewport,
  };
}

/** Home folders name the person: `/Users/ann/x` → `~/x`. */
export function withoutHomePaths(text: string): string {
  return text
    .replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/gi, "~");
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The tab's recent error notices as the wire carries them (newest kept). */
export function recentErrors(entries: ReadonlyArray<{ time: string; text: string }>): BugReportError[] {
  return entries
    .filter((entry) => ISO.test(entry.time) && typeof entry.text === "string" && entry.text.trim() !== "")
    .slice(-BUG_REPORT_LIMITS.errors)
    .map((entry) => ({
      time: entry.time,
      // Lines and tabs survive; other control characters would refuse the report.
      // eslint-disable-next-line no-control-regex
      text: withoutHomePaths(entry.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, BUG_REPORT_LIMITS.errorChars),
    }));
}

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Enabled packages from `GET /api/packages`. Workspace packages ship with
 *  the build and carry no version of their own, hence `bundled`. */
export function enabledPackages(body: unknown): BugReportPackage[] {
  const list = typeof body === "object" && body !== null && Array.isArray((body as { packages?: unknown }).packages)
    ? (body as { packages: unknown[] }).packages
    : [];
  const out: BugReportPackage[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const { id, enabled, status } = item as { id?: unknown; enabled?: unknown; status?: unknown };
    if (typeof id !== "string" || !PACKAGE_ID.test(id)) continue;
    if (status === "disabled" || (status === undefined && enabled !== true)) continue;
    out.push({ id, version: "bundled" });
    if (out.length >= BUG_REPORT_LIMITS.packages) break;
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** A GitHub username as typed: `@` and spaces dropped; "" when not one. */
export function contactName(raw: string): string {
  const name = raw.trim().replace(/^@/, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(name) ? name : "";
}
