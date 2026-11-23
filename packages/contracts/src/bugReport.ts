/**
 * Nightly bug reports: the one wire shape the desktop shell — or, for a page
 * opened in a browser, the Polyth server that served it — sends to the
 * report relay (`packages/report-relay`, `POST /v1/report`) and the relay
 * accepts. Every object is exact — an unknown field rejects the report — so a
 * client can never smuggle extra data past the allowlist it shows the person
 * before sending. The tester password travels in the `Authorization` header,
 * never in the body.
 *
 * Browser-safe: no Node imports.
 */

export const BUG_REPORT_VERSION = 1;

export const BUG_REPORT_LIMITS = Object.freeze({
  textChars: 4_000,
  contactChars: 39,
  settingsKeys: 80,
  settingKeyChars: 64,
  settingValueChars: 160,
  packages: 200,
  errors: 10,
  errorChars: 1_200,
  /** Decoded JPEG bytes. */
  screenshotBytes: 1_500_000,
  /** Longest screenshot edge in pixels; the sender downscales to it. */
  screenshotEdge: 1_600,
  /** Whole request body: the base64 screenshot plus the JSON around it. */
  bodyBytes: 2_200_000,
  /** Tester password length the client accepts and sends. */
  passwordChars: 200,
});

export type BugReportChannel = "nightly" | "stable";
export type BugReportPlatform = "darwin" | "win32" | "linux";
/** The browser's operating system as the page can tell it. */
export type BugReportBrowserPlatform = BugReportPlatform | "android" | "ios" | "unknown";

/** A report from the desktop shell (every shell up to 1.2.370 sends this). */
export interface BugReportDesktopApp {
  /** `X.Y.Z` or `X.Y.N-nightly`. */
  version: string;
  channel: BugReportChannel;
  edition: "standard" | "workstation";
  platform: BugReportPlatform;
  arch: string;
  /** Operating-system release as the OS reports it (`24.6.0`, `10.0.26100`). */
  osVersion: string;
  electron: string;
  chromium: string;
  packaged: boolean;
  /** UI language tag (`uk`, `en-US`). */
  locale: string;
}

/** A report from a page opened in a browser, sent by its Polyth server. */
export interface BugReportBrowserApp {
  client: "browser";
  /** The server's version: `X.Y.Z` or `X.Y.N-nightly`. */
  version: string;
  channel: BugReportChannel;
  edition: "standard";
  /** The browser's operating system. */
  platform: BugReportBrowserPlatform;
  /** Browser name and major version (`Chrome 131`, `Safari 18`), or "". */
  browser: string;
  /** The server's operating system and CPU architecture. */
  serverPlatform: BugReportPlatform;
  serverArch: string;
  /** UI language tag (`uk`, `en-US`). */
  locale: string;
}

export type BugReportApp = BugReportDesktopApp | BugReportBrowserApp;

export const isBrowserReportApp = (app: BugReportApp): app is BugReportBrowserApp =>
  (app as Partial<BugReportBrowserApp>).client === "browser";

export interface BugReportWeb {
  /** The web bundle's build id, or "" when the window is not the web app. */
  build: string;
  /** The server's version, or "" when unknown. */
  serverVersion: string;
  /** What the window showed: a view or page id, never a session or project id. */
  view: string;
  viewport: { width: number; height: number; scale: number };
}

export type BugReportSettingValue = string | number | boolean;

export interface BugReportPackage {
  id: string;
  version: string;
}

export interface BugReportError {
  /** ISO time the notice appeared. */
  time: string;
  /** The notice's report text (`errorReportText` style): no paths or accounts. */
  text: string;
}

export interface BugReportScreenshot {
  type: "image/jpeg";
  width: number;
  height: number;
  /** Standard base64 of the JPEG bytes. */
  data: string;
}

export interface BugReportPayload {
  version: typeof BUG_REPORT_VERSION;
  /** UUID v4 the client made; the relay treats a repeat as the same report. */
  reportId: string;
  /** 32 lowercase hex: an install id that changes every UTC day. */
  install: string;
  /** ISO time the person pressed Send. */
  createdAt: string;
  app: BugReportApp;
  web: BugReportWeb;
  /** Allowlisted settings, `group.name` keys. */
  settings: Record<string, BugReportSettingValue>;
  packages: BugReportPackage[];
  errors: BugReportError[];
  /** What the person wrote; may be empty. */
  text: string;
  /** An optional GitHub username for follow-up, or "". */
  contact: string;
  screenshot: BugReportScreenshot | null;
}

/** `POST /v1/report` answers. HTTP status: created/added 200, invalid 400,
 *  password 401, version 422, rate 429, unavailable 503. */
export type BugReportResult =
  | { result: "created"; issue: number }
  | { result: "added"; issue: number }
  | { result: "invalid" }
  | { result: "password" }
  | { result: "version" }
  | { result: "rate" }
  | { result: "unavailable" };

export const BUG_REPORT_RESULTS = ["created", "added", "invalid", "password", "version", "rate", "unavailable"] as const;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,5}(?:-nightly)?$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTALL = /^[0-9a-f]{32}$/;
const ARCH = /^[a-z0-9_]{1,16}$/;
const DOTTED = /^[0-9][0-9.]{0,31}$/;
const BROWSER = /^(?:|[A-Za-z][A-Za-z ]{0,30}(?: [0-9]{1,4})?)$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const BUILD = /^[A-Za-z0-9._-]{0,64}$/;
const VIEW = /^[A-Za-z0-9._:-]{0,64}$/;
const SETTING_KEY = /^[a-z][A-Za-z0-9]{0,30}(?:\.[A-Za-z0-9]{1,30}){0,2}$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const CONTACT = /^(?:|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// Printable single-line text: no control characters at all.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// Multi-line text keeps \n and \t only.
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f]/;

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value: Plain, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && own.every((key) => keys.includes(key));
};

const line = (value: unknown, max: number, pattern?: RegExp): value is string =>
  typeof value === "string" && value.length <= max && !CONTROL.test(value) && (!pattern || pattern.test(value));

const block = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !CONTROL_EXCEPT_LINES.test(value);

const int = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** An ISO time at most `pastMs` before `now` and a day after it (clock skew). */
const isoWithin = (value: unknown, now: number, pastMs: number): value is string => {
  if (typeof value !== "string" || !ISO.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= now - pastMs && time <= now + DAY;
};

const DAY = 86_400_000;
/** A report waits in an outbox (desktop or server) for at most this long. */
export const BUG_REPORT_MAX_AGE_MS = 7 * DAY;

const channelOf = (version: string): BugReportChannel => version.endsWith("-nightly") ? "nightly" : "stable";
const isPlatform = (value: unknown): value is BugReportPlatform => value === "darwin" || value === "win32" || value === "linux";

function parseBrowserApp(value: Plain): BugReportBrowserApp | null {
  if (!exactKeys(value, ["client", "version", "channel", "edition", "platform", "browser", "serverPlatform", "serverArch", "locale"])) return null;
  const { version, channel, edition, platform, browser, serverPlatform, serverArch, locale } = value;
  if (!line(version, 24, VERSION) || channel !== channelOf(version) || edition !== "standard") return null;
  if (!(isPlatform(platform) || platform === "android" || platform === "ios" || platform === "unknown")) return null;
  if (!line(browser, 40, BROWSER) || !isPlatform(serverPlatform) || !line(serverArch, 16, ARCH)) return null;
  if (!line(locale, 35, LOCALE)) return null;
  return { client: "browser", version, channel: channelOf(version), edition, platform, browser, serverPlatform, serverArch, locale };
}

function parseApp(value: unknown): BugReportApp | null {
  if (isPlain(value) && value.client === "browser") return parseBrowserApp(value);
  if (!isPlain(value) || !exactKeys(value, ["version", "channel", "edition", "platform", "arch", "osVersion", "electron", "chromium", "packaged", "locale"])) return null;
  const { version, channel, edition, platform, arch, osVersion, electron, chromium, packaged, locale } = value;
  if (!line(version, 24, VERSION)) return null;
  const expected = channelOf(version);
  if (channel !== expected) return null;
  if (edition !== "standard" && edition !== "workstation") return null;
  if (!isPlatform(platform)) return null;
  if (!line(arch, 16, ARCH) || !line(osVersion, 64) || !line(electron, 32, DOTTED) || !line(chromium, 32, DOTTED)) return null;
  if (typeof packaged !== "boolean" || !line(locale, 35, LOCALE)) return null;
  return { version, channel: expected, edition, platform, arch, osVersion, electron, chromium, packaged, locale };
}

function parseWeb(value: unknown): BugReportWeb | null {
  if (!isPlain(value) || !exactKeys(value, ["build", "serverVersion", "view", "viewport"])) return null;
  const { build, serverVersion, view, viewport } = value;
  if (!line(build, 64, BUILD) || !line(view, 64, VIEW)) return null;
  if (!(serverVersion === "" || line(serverVersion, 24, VERSION))) return null;
  if (!isPlain(viewport) || !exactKeys(viewport, ["width", "height", "scale"])) return null;
  const { width, height, scale } = viewport;
  if (!int(width, 0, 20_000) || !int(height, 0, 20_000)) return null;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.25 || scale > 8) return null;
  return { build, serverVersion: serverVersion as string, view, viewport: { width, height, scale } };
}

function parseSettings(value: unknown): Record<string, BugReportSettingValue> | null {
  if (!isPlain(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > BUG_REPORT_LIMITS.settingsKeys) return null;
  const out: Record<string, BugReportSettingValue> = {};
  for (const [key, setting] of entries) {
    if (key.length > BUG_REPORT_LIMITS.settingKeyChars || !SETTING_KEY.test(key)) return null;
    if (typeof setting === "boolean") out[key] = setting;
    else if (typeof setting === "number" && Number.isFinite(setting)) out[key] = setting;
    else if (line(setting, BUG_REPORT_LIMITS.settingValueChars)) out[key] = setting;
    else return null;
  }
  return out;
}

function parsePackages(value: unknown): BugReportPackage[] | null {
  if (!Array.isArray(value) || value.length > BUG_REPORT_LIMITS.packages) return null;
  const out: BugReportPackage[] = [];
  for (const item of value) {
    if (!isPlain(item) || !exactKeys(item, ["id", "version"])) return null;
    if (!line(item.id, 64, PACKAGE_ID) || !line(item.version, 32, PACKAGE_VERSION)) return null;
    out.push({ id: item.id, version: item.version });
  }
  return out;
}

function parseErrors(value: unknown, now: number): BugReportError[] | null {
  if (!Array.isArray(value) || value.length > BUG_REPORT_LIMITS.errors) return null;
  const out: BugReportError[] = [];
  for (const item of value) {
    if (!isPlain(item) || !exactKeys(item, ["time", "text"])) return null;
    // A notice may be a week older than a report that then waited a week.
    if (!isoWithin(item.time, now, 2 * BUG_REPORT_MAX_AGE_MS) || !block(item.text, BUG_REPORT_LIMITS.errorChars)) return null;
    out.push({ time: item.time, text: item.text });
  }
  return out;
}

/** Decoded byte length of standard base64 without allocating it. */
export function base64DecodedLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function parseScreenshot(value: unknown): BugReportScreenshot | null | undefined {
  if (value === null) return null;
  if (!isPlain(value) || !exactKeys(value, ["type", "width", "height", "data"])) return undefined;
  const { type, width, height, data } = value;
  if (type !== "image/jpeg") return undefined;
  const edge = BUG_REPORT_LIMITS.screenshotEdge;
  if (!int(width, 1, edge) || !int(height, 1, edge)) return undefined;
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  if (base64DecodedLength(data) > BUG_REPORT_LIMITS.screenshotBytes) return undefined;
  // FF D8 FF: every JPEG starts with an SOI marker followed by another marker.
  if (!data.startsWith("/9j/")) return undefined;
  return { type, width, height, data };
}

/** The report when `input` is exactly a valid one, else null. `now` bounds
 *  the timestamps: `createdAt` may be up to `BUG_REPORT_MAX_AGE_MS` old (a
 *  report that waited offline) and a day ahead (clock skew). */
export function parseBugReport(input: unknown, now: number = Date.now()): BugReportPayload | null {
  if (!isPlain(input)) return null;
  if (!exactKeys(input, ["version", "reportId", "install", "createdAt", "app", "web", "settings", "packages", "errors", "text", "contact", "screenshot"])) return null;
  if (input.version !== BUG_REPORT_VERSION) return null;
  if (!line(input.reportId, 36, UUID_V4) || !line(input.install, 32, INSTALL)) return null;
  if (!isoWithin(input.createdAt, now, BUG_REPORT_MAX_AGE_MS)) return null;
  const app = parseApp(input.app);
  const web = parseWeb(input.web);
  const settings = parseSettings(input.settings);
  const packages = parsePackages(input.packages);
  const errors = parseErrors(input.errors, now);
  const screenshot = parseScreenshot(input.screenshot);
  if (!app || !web || !settings || !packages || !errors || screenshot === undefined) return null;
  if (!block(input.text, BUG_REPORT_LIMITS.textChars)) return null;
  if (!line(input.contact, BUG_REPORT_LIMITS.contactChars, CONTACT)) return null;
  return {
    version: BUG_REPORT_VERSION,
    reportId: input.reportId,
    install: input.install,
    createdAt: input.createdAt,
    app, web, settings, packages, errors,
    text: input.text,
    contact: input.contact,
    screenshot,
  };
}

/** A tester password: printable ASCII without spaces, so every hop (the
 *  `Authorization` header, `hash-password`, the OS keychain) carries the
 *  same bytes. */
export function isTesterPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= BUG_REPORT_LIMITS.passwordChars && /^[!-~]+$/.test(value);
}

/** HTTP status the relay answers each result with. */
export function bugReportStatus(result: BugReportResult["result"]): number {
  switch (result) {
    case "created": case "added": return 200;
    case "invalid": return 400;
    case "password": return 401;
    case "version": return 422;
    case "rate": return 429;
    case "unavailable": return 503;
  }
}
