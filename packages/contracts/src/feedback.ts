/**
 * Feedback: the one wire shape a Polyth app — or, for a page opened in a
 * browser, the Polyth server that served it — sends to the feedback intake
 * (`packages/report-relay`, `POST /v1/feedback`) and the intake accepts.
 *
 * It generalises the nightly bug report (`./bugReport.ts`): any person can
 * leave a bug, an idea, a "this is awkward" or a "this is good", with no
 * account anywhere. Every object is exact (an unknown field rejects the
 * whole feedback), and every optional part travels only with its own
 * consent flag, so the sheet's "what will be sent" preview and the wire
 * can never disagree:
 *
 * - `consent.technical` ⇔ `technical` is present (build facts, settings
 *   allowlist, enabled packages, recent error notices),
 * - `consent.screenshot` ⇔ `screenshot` is present,
 * - `consent.profile` ⇔ `profile` is present (role, AI experience),
 * - `consent.contact` ⇔ `contact` is not empty.
 *
 * `basics` is always sent and always shown: version, channel, edition and
 * language, enough to tell which build a remark is about.
 *
 * Browser-safe: no Node imports.
 */

import {
  BUG_REPORT_LIMITS, BUG_REPORT_MAX_AGE_MS, INSTALL, LOCALE, UUID_V4, VERSION,
  block, exactKeys, isPlain, isoWithin, line,
  parseApp, parseErrors, parsePackages, parseScreenshot, parseSettings, parseWeb,
  type BugReportApp, type BugReportError, type BugReportPackage, type BugReportScreenshot,
  type BugReportSettingValue, type BugReportWeb,
} from "./bugReport.ts";

export const FEEDBACK_VERSION = 1;

export const FEEDBACK_KINDS = ["bug", "idea", "pain", "praise"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** What the person does, as a short list; "other" is always there. */
export const FEEDBACK_ROLES = ["lawyer", "accountant", "developer", "researcher", "designer", "manager", "student", "other"] as const;
export type FeedbackRole = (typeof FEEDBACK_ROLES)[number];

/** How used they are to AI tools. */
export const FEEDBACK_EXPERIENCE = ["new", "sometimes", "daily"] as const;
export type FeedbackExperience = (typeof FEEDBACK_EXPERIENCE)[number];

export const FEEDBACK_LIMITS = Object.freeze({
  textChars: 4_000,
  contactChars: 120,
  /** Whole request body: the base64 screenshot plus the JSON around it. */
  bodyBytes: BUG_REPORT_LIMITS.bodyBytes,
});

export interface FeedbackBasics {
  /** `X.Y.Z` or `X.Y.N-nightly`. */
  version: string;
  channel: "nightly" | "stable";
  edition: "standard" | "workstation";
  /** UI language tag (`uk`, `en-US`). */
  locale: string;
}

export interface FeedbackTechnical {
  app: BugReportApp;
  web: BugReportWeb;
  /** Allowlisted settings, `group.name` keys. */
  settings: Record<string, BugReportSettingValue>;
  packages: BugReportPackage[];
  errors: BugReportError[];
}

export interface FeedbackProfile {
  role: FeedbackRole;
  experience: FeedbackExperience;
}

export interface FeedbackConsent {
  technical: boolean;
  screenshot: boolean;
  profile: boolean;
  contact: boolean;
}

export interface FeedbackPayload {
  version: typeof FEEDBACK_VERSION;
  /** UUID v4 the client made; the intake treats a repeat as the same feedback. */
  feedbackId: string;
  /** 32 lowercase hex. A per-day pseudonym unless the person agreed to
   *  `profile` or `contact`, then the one they can reset in Settings. */
  install: string;
  /** ISO time the person pressed Send. */
  createdAt: string;
  kind: FeedbackKind;
  /** What the person wrote: 1–4000 characters. */
  text: string;
  /** An email or any way to reach them, or "" without `consent.contact`. */
  contact: string;
  consent: FeedbackConsent;
  basics: FeedbackBasics;
  technical: FeedbackTechnical | null;
  profile: FeedbackProfile | null;
  screenshot: BugReportScreenshot | null;
}

/** `POST /v1/feedback` answers. HTTP status: received 200, invalid 400,
 *  rate 429, unavailable 503. `ref` is the number shown to the person. */
export type FeedbackResult =
  | { result: "received"; ref: number }
  | { result: "invalid" }
  | { result: "rate" }
  | { result: "unavailable" };

export const FEEDBACK_RESULTS = ["received", "invalid", "rate", "unavailable"] as const;

export function feedbackStatus(result: FeedbackResult["result"]): number {
  switch (result) {
    case "received": return 200;
    case "invalid": return 400;
    case "rate": return 429;
    case "unavailable": return 503;
  }
}

/** A contact: a plain email or a short handle, single line, no spaces. */
const CONTACT = /^[^\s@<>()"',;]{1,64}@[^\s@<>()"',;]{1,63}\.[^\s@<>()"',;]{2,24}$|^@?[A-Za-z0-9._-]{2,64}$/;

/** True for a contact the intake accepts (what the sheet checks before Send). */
export const isFeedbackContact = (value: string): boolean => value.length <= FEEDBACK_LIMITS.contactChars && CONTACT.test(value);

const isKind = (value: unknown): value is FeedbackKind => (FEEDBACK_KINDS as readonly unknown[]).includes(value);

function parseBasics(value: unknown): FeedbackBasics | null {
  if (!isPlain(value) || !exactKeys(value, ["version", "channel", "edition", "locale"])) return null;
  const { version, channel, edition, locale } = value;
  if (!line(version, 24, VERSION) || !line(locale, 35, LOCALE)) return null;
  const expected = version.endsWith("-nightly") ? "nightly" : "stable";
  if (channel !== expected) return null;
  if (edition !== "standard" && edition !== "workstation") return null;
  return { version, channel: expected, edition, locale };
}

function parseConsent(value: unknown): FeedbackConsent | null {
  if (!isPlain(value) || !exactKeys(value, ["technical", "screenshot", "profile", "contact"])) return null;
  const { technical, screenshot, profile, contact } = value;
  if (typeof technical !== "boolean" || typeof screenshot !== "boolean" || typeof profile !== "boolean" || typeof contact !== "boolean") return null;
  return { technical, screenshot, profile, contact };
}

function parseProfile(value: unknown): FeedbackProfile | null {
  if (!isPlain(value) || !exactKeys(value, ["role", "experience"])) return null;
  const { role, experience } = value;
  if (!(FEEDBACK_ROLES as readonly unknown[]).includes(role)) return null;
  if (!(FEEDBACK_EXPERIENCE as readonly unknown[]).includes(experience)) return null;
  return { role: role as FeedbackRole, experience: experience as FeedbackExperience };
}

function parseTechnical(value: unknown, now: number): FeedbackTechnical | null {
  if (!isPlain(value) || !exactKeys(value, ["app", "web", "settings", "packages", "errors"])) return null;
  const app = parseApp(value.app);
  const web = parseWeb(value.web);
  const settings = parseSettings(value.settings);
  const packages = parsePackages(value.packages);
  const errors = parseErrors(value.errors, now);
  if (!app || !web || !settings || !packages || !errors) return null;
  return { app, web, settings, packages, errors };
}

/** The feedback when `input` is exactly a valid one, else null. `now` bounds
 *  the timestamp: `createdAt` may be up to `BUG_REPORT_MAX_AGE_MS` old (it
 *  waited offline) and a day ahead (clock skew). */
export function parseFeedback(input: unknown, now: number = Date.now()): FeedbackPayload | null {
  if (!isPlain(input)) return null;
  if (!exactKeys(input, ["version", "feedbackId", "install", "createdAt", "kind", "text", "contact", "consent", "basics", "technical", "profile", "screenshot"])) return null;
  if (input.version !== FEEDBACK_VERSION) return null;
  if (!line(input.feedbackId, 36, UUID_V4) || !line(input.install, 32, INSTALL)) return null;
  if (!isoWithin(input.createdAt, now, BUG_REPORT_MAX_AGE_MS)) return null;
  if (!isKind(input.kind)) return null;
  if (!block(input.text, FEEDBACK_LIMITS.textChars) || input.text.trim() === "") return null;
  const consent = parseConsent(input.consent);
  const basics = parseBasics(input.basics);
  if (!consent || !basics) return null;

  // Each optional part is present exactly when its consent flag says so.
  const technical = input.technical === null ? null : parseTechnical(input.technical, now);
  if (consent.technical !== (technical !== null) || (input.technical !== null && technical === null)) return null;
  const profile = input.profile === null ? null : parseProfile(input.profile);
  if (consent.profile !== (profile !== null) || (input.profile !== null && profile === null)) return null;
  const screenshot = parseScreenshot(input.screenshot);
  if (screenshot === undefined || consent.screenshot !== (screenshot !== null)) return null;
  if (typeof input.contact !== "string" || !line(input.contact, FEEDBACK_LIMITS.contactChars)) return null;
  if (consent.contact !== (input.contact !== "") || (input.contact !== "" && !CONTACT.test(input.contact))) return null;
  // The technical block and the basics describe the same build.
  if (technical && technical.app.version !== basics.version) return null;

  return {
    version: FEEDBACK_VERSION,
    feedbackId: input.feedbackId,
    install: input.install,
    createdAt: input.createdAt,
    kind: input.kind,
    text: input.text,
    contact: input.contact,
    consent, basics, technical, profile, screenshot,
  };
}

export interface ComposeFeedbackInput {
  now: number;
  /** UUID v4. */
  feedbackId: string;
  kind: unknown;
  text: unknown;
  /** What the person typed, or "" / a non-string for none. */
  contact: unknown;
  basics: FeedbackBasics;
  /** The technical block the sender assembled, or null when the person left it out. */
  technical: unknown;
  /** The person's profile, or null when they left it out. */
  profile: unknown;
  screenshot: BugReportScreenshot | null;
  /** The pseudonym that changes every UTC day. */
  dailyInstall: string;
  /** The pseudonym the person can reset. */
  personInstall: string;
}

/** The one place a sender turns a draft into the wire shape. Consent is not
 *  asked separately: a part is sent exactly when it is present, so the sheet's
 *  preview and the wire cannot disagree. The pseudonym is the stable one only
 *  when the person chose to be known (a profile or a way to reach them);
 *  otherwise it is the one that changes every day. Null when the result is not
 *  a valid feedback. */
export function composeFeedback(input: ComposeFeedbackInput): FeedbackPayload | null {
  const contact = typeof input.contact === "string" ? input.contact.trim() : "";
  const technical = input.technical ?? null;
  const profile = input.profile ?? null;
  return parseFeedback({
    version: FEEDBACK_VERSION,
    feedbackId: input.feedbackId,
    install: profile !== null || contact !== "" ? input.personInstall : input.dailyInstall,
    createdAt: new Date(input.now).toISOString(),
    kind: input.kind,
    text: typeof input.text === "string" ? input.text.trim() : input.text,
    contact,
    consent: { technical: technical !== null, screenshot: input.screenshot !== null, profile: profile !== null, contact: contact !== "" },
    basics: input.basics,
    technical,
    profile,
    screenshot: input.screenshot,
  }, input.now);
}

// Re-exported so a client builds one shape from one module.
export type { BugReportApp, BugReportError, BugReportPackage, BugReportScreenshot, BugReportSettingValue, BugReportWeb };
