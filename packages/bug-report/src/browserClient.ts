// What a report from a page opened in a browser says about that browser: the
// OS family, the browser's name and major version, and the language tag. Never
// the raw user-agent string (it carries device models and build numbers).
// Browser-safe and pure, so it is unit-tested.
import type { BugReportBrowserPlatform } from "@polyth/contracts/bug-report";

export interface BrowserClient {
  platform: BugReportBrowserPlatform;
  /** `Chrome 131`, `Safari 18`, or "" when it cannot be told. */
  browser: string;
  locale: string;
}

export interface BrowserFacts {
  userAgent: string;
  /** `navigator.userAgentData.platform` where the browser has it. */
  uaPlatform?: string;
  /** `navigator.maxTouchPoints`: an iPad asks for desktop pages as a Mac. */
  maxTouchPoints?: number;
  language?: string;
}

const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export function browserPlatform(facts: BrowserFacts): BugReportBrowserPlatform {
  const named = facts.uaPlatform?.toLowerCase() ?? "";
  const ua = facts.userAgent;
  if (named === "android" || /Android/.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (facts.maxTouchPoints ?? 0) > 1)) return "ios";
  if (named === "macos" || /Macintosh|Mac OS X/.test(ua)) return "darwin";
  if (named === "windows" || /Windows/.test(ua)) return "win32";
  if (named === "linux" || named === "chrome os" || named === "chromeos" || /Linux|CrOS|X11/.test(ua)) return "linux";
  return "unknown";
}

const BROWSERS: ReadonlyArray<[name: string, pattern: RegExp]> = [
  ["Edge", /\bEdg(?:e|A|iOS)?\/(\d{1,4})/],
  ["Opera", /\bOPR\/(\d{1,4})/],
  ["Samsung Internet", /\bSamsungBrowser\/(\d{1,4})/],
  ["Firefox", /\b(?:Firefox|FxiOS)\/(\d{1,4})/],
  ["Chrome", /\b(?:Chrome|CriOS)\/(\d{1,4})/],
  ["Safari", /\bVersion\/(\d{1,4})[^ ]* (?:Mobile\/\S+ )?Safari\//],
];

export function browserName(userAgent: string): string {
  for (const [name, pattern] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  return "";
}

export function browserClient(facts: BrowserFacts): BrowserClient {
  const language = (facts.language ?? "").replace(/_/g, "-");
  return {
    platform: browserPlatform(facts),
    browser: browserName(facts.userAgent),
    locale: LOCALE.test(language) ? language : "en",
  };
}

/** True where `getDisplayMedia({ preferCurrentTab })` offers just this tab:
 *  desktop Chromium. Elsewhere the picker would offer whole screens and
 *  other windows, so the sheet asks for an attached image instead. */
export function canCaptureThisTab(facts: BrowserFacts & { hasDisplayMedia: boolean; brands?: readonly string[] }): boolean {
  if (!facts.hasDisplayMedia) return false;
  const platform = browserPlatform(facts);
  if (platform === "android" || platform === "ios" || platform === "unknown") return false;
  const chromium = facts.brands ? facts.brands.includes("Chromium") : /\bChrome\/\d/.test(facts.userAgent) && !/\bFirefox\//.test(facts.userAgent);
  return chromium && !/\bElectron\//.test(facts.userAgent);
}
