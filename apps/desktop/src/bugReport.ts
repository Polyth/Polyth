// Feedback (docs/dev/desktop.md#feedback). The renderer's sheet asks for a
// capture, shows the person exactly what goes, and hands back a draft; this
// module adds what only the desktop knows (build, desktop settings, the two
// pseudonyms), validates the whole feedback against the shared wire shape
// (`composeFeedback`) and sends it to the intake: no password, no account.
// Nothing here imports Electron: main.ts passes the screenshot and `net.fetch`
// in, so the logic is unit-tested.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUG_REPORT_LIMITS,
  type BugReportDesktopApp,
  type BugReportSettingValue,
} from "@polyth/contracts/bug-report";
import type { PolythEdition } from "@polyth/contracts/edition";
import {
  FEEDBACK_EXPERIENCE,
  FEEDBACK_ROLES,
  composeFeedback,
  parseFeedback,
  type FeedbackPayload,
  type FeedbackProfile,
} from "@polyth/contracts/feedback";

import type { DesktopBugReportCapture, DesktopBugReportOutcome, DesktopBugReportState } from "./types.ts";

export const DEFAULT_BUG_REPORT_ORIGIN = "https://reports.polyth.app";
const MINUTE = 60_000;
/** Feedback kept waiting for the intake at most; the oldest goes first. */
const OUTBOX_MAX = 10;
const OUTBOX_RETRY_MS = 15 * MINUTE;
const CAPTURE_TTL_MS = 15 * MINUTE;
const SEND_TIMEOUT_MS = 30_000;
const JPEG_QUALITIES = [80, 70, 60, 50] as const;

/** Where feedback goes, or null when this build sends none. Every build sends
 *  it, stable or nightly, in both editions, and only when the person presses
 *  Send on the sheet that shows them the exact bytes.
 *  `POLYTH_BUG_REPORT_ORIGIN` points at another intake (`https:` or loopback
 *  `http:`); `off` turns the whole feature off, for an administrator who wants
 *  no outbound call at all (docs/security/workstation-edition.md). */
export function bugReportOrigin(input: {
  version: string;
  edition: PolythEdition;
  env: Readonly<Record<string, string | undefined>>;
}): string | null {
  const raw = input.env.POLYTH_BUG_REPORT_ORIGIN?.trim();
  if (raw === "off") return null;
  if (!raw) return DEFAULT_BUG_REPORT_ORIGIN;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** 32 hex that change every UTC day: nobody can link two days of anonymous
 *  feedback to one computer. */
export function dailyInstallId(secretHex: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(day).digest("hex").slice(0, 32);
}

/** The few NativeImage methods the encoder needs (a fake in tests). */
export interface CapturedImage {
  getSize(): { width: number; height: number };
  resize(options: { width: number; height: number; quality: "good" }): CapturedImage;
  toJPEG(quality: number): Buffer;
}

/** A marked-up screenshot from the sheet is at most the wire's 1600 px at
 *  high JPEG quality; anything far larger is refused before it is decoded. */
export const MARKED_SCREENSHOT_MAX_BYTES = 8_000_000;

export interface EncodedScreenshot {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Downscale to the wire's longest edge and re-encode until it fits. */
export function encodeScreenshot(image: CapturedImage): EncodedScreenshot | null {
  const size = image.getSize();
  if (size.width < 1 || size.height < 1) return null;
  let edge: number = BUG_REPORT_LIMITS.screenshotEdge;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const scale = Math.min(1, edge / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const sized = scale < 1 ? image.resize({ width, height, quality: "good" }) : image;
    for (const quality of JPEG_QUALITIES) {
      const jpeg = sized.toJPEG(quality);
      if (jpeg.length > 0 && jpeg.length <= BUG_REPORT_LIMITS.screenshotBytes) return { jpeg, width, height };
    }
    edge = Math.round(edge * 0.75);
  }
  return null;
}

interface StoreFile {
  /** 64 hex: the secret the daily pseudonym is derived from. */
  secret: string;
  /** 32 hex: the pseudonym the person can reset. */
  person: string;
  profile?: FeedbackProfile;
}

export interface BugReportClientOptions {
  /** `<userData>/desktop`: the store file and the outbox live here. */
  dir: string;
  origin: string | null;
  app: Omit<BugReportDesktopApp, "channel" | "locale">;
  locale: () => string;
  /** What the desktop adds to the settings: `desktop.*` keys. */
  desktopSettings: () => Record<string, BugReportSettingValue>;
  fetch: typeof fetch;
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

export interface BugReportClient {
  state(): DesktopBugReportState;
  capture(screenshot: EncodedScreenshot | null): DesktopBugReportCapture;
  /** The person's marked-up screenshot (already re-encoded by main) replaces
   *  the held capture's; null when that capture is gone or nothing decoded. */
  annotate(captureId: unknown, screenshot: EncodedScreenshot | null): DesktopBugReportCapture["screenshot"];
  send(draft: unknown): Promise<DesktopBugReportOutcome>;
  /** Erases what this computer sent under its resettable pseudonym and starts
   *  a new one. */
  forget(): Promise<{ result: "forgotten"; count: number } | { result: "unavailable" }>;
  flushOutbox(): Promise<void>;
  dispose(): void;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asProfile = (value: unknown): FeedbackProfile | undefined =>
  isPlain(value)
  && (FEEDBACK_ROLES as readonly unknown[]).includes(value.role)
  && (FEEDBACK_EXPERIENCE as readonly unknown[]).includes(value.experience)
    ? { role: value.role as FeedbackProfile["role"], experience: value.experience as FeedbackProfile["experience"] }
    : undefined;

type Answer = DesktopBugReportOutcome | { result: "retry" };

export function createBugReportClient(options: BugReportClientOptions): BugReportClient {
  const now = options.now ?? Date.now;
  const storePath = join(options.dir, "bug-report.json");
  const outboxDir = join(options.dir, "bug-reports");
  let store = readStore();
  let capture: { id: string; screenshot: EncodedScreenshot | null; at: number } | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;

  function readStore(): StoreFile {
    try {
      const raw = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
      if (isPlain(raw) && typeof raw.secret === "string" && /^[0-9a-f]{64}$/.test(raw.secret)) {
        const profile = asProfile(raw.profile);
        return {
          secret: raw.secret,
          person: typeof raw.person === "string" && /^[0-9a-f]{32}$/.test(raw.person) ? raw.person : randomBytes(16).toString("hex"),
          ...(profile ? { profile } : {}),
        };
      }
    } catch { /* first run, or an unreadable file: start again */ }
    return { secret: randomBytes(32).toString("hex"), person: randomBytes(16).toString("hex") };
  }

  function writeStore(): void {
    try {
      mkdirSync(options.dir, { recursive: true });
      const temp = `${storePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, storePath);
    } catch (error) {
      options.log("Could not save the feedback state", error);
    }
  }

  function outboxFiles(): string[] {
    try {
      return readdirSync(outboxDir).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort((a, b) => mtime(a) - mtime(b));
    } catch {
      return [];
    }
  }

  function mtime(name: string): number {
    try { return statSync(join(outboxDir, name)).mtimeMs; } catch { return 0; }
  }

  function enqueue(feedback: FeedbackPayload): void {
    try {
      mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
      const path = join(outboxDir, `${feedback.feedbackId}.json`);
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(feedback), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
      const files = outboxFiles();
      for (const name of files.slice(0, Math.max(0, files.length - OUTBOX_MAX))) rmSync(join(outboxDir, name), { force: true });
    } catch (error) {
      options.log("Could not keep the feedback for later", error);
    }
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (retryTimer || outboxFiles().length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushOutbox();
    }, OUTBOX_RETRY_MS);
    retryTimer.unref?.();
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
    if (!options.origin) return null;
    try {
      const response = await options.fetch(new URL(path, options.origin).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      let parsed: unknown = null;
      try { parsed = await response.json(); } catch { /* answered below by status */ }
      return { status: response.status, body: parsed };
    } catch (error) {
      options.log("The feedback intake could not be reached", error instanceof Error ? error.name : undefined);
      return null;
    }
  }

  async function sendOne(feedback: FeedbackPayload): Promise<Answer> {
    if (!options.origin) return { result: "unavailable" };
    const answer = await post("/v1/feedback", feedback);
    if (!answer) return { result: "retry" };
    const ref = isPlain(answer.body) && Number.isInteger(answer.body.ref) && (answer.body.ref as number) > 0 ? answer.body.ref as number : 0;
    if (answer.status === 200 && isPlain(answer.body) && answer.body.result === "received" && ref) return { result: "received", ref };
    if (answer.status === 400) return { result: "invalid" };
    if (answer.status === 429) return { result: "rate" };
    // An overloaded or unavailable intake: it goes later.
    return { result: "retry" };
  }

  async function flushOutbox(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const name of outboxFiles()) {
        const path = join(outboxDir, name);
        let feedback: FeedbackPayload | null = null;
        try { feedback = parseFeedback(JSON.parse(readFileSync(path, "utf8")) as unknown, now()); } catch { feedback = null; }
        if (!feedback) { rmSync(path, { force: true }); continue; }
        const answer = await sendOne(feedback);
        if (answer.result === "retry" || answer.result === "rate") break;
        // Sent, or refused for good (a stale shape).
        rmSync(path, { force: true });
      }
    })().finally(() => {
      flushing = null;
      scheduleRetry();
    });
    return flushing;
  }

  function base(at: number) {
    return {
      app: appInfo(),
      settings: options.desktopSettings(),
      installDaily: dailyInstallId(store.secret, at),
      installPerson: store.person,
      savedProfile: store.profile ?? null,
    };
  }

  function appInfo(): BugReportDesktopApp {
    return {
      ...options.app,
      channel: options.app.version.endsWith("-nightly") ? "nightly" : "stable",
      locale: localeTag(options.locale()),
    };
  }

  /** The profile the person shared is kept, so the next sheet opens with it. */
  function remember(feedback: FeedbackPayload): void {
    if (feedback.profile && JSON.stringify(store.profile) !== JSON.stringify(feedback.profile)) {
      store = { ...store, profile: feedback.profile };
      writeStore();
    }
  }

  const screenshotView = (screenshot: EncodedScreenshot | null): DesktopBugReportCapture["screenshot"] => screenshot
    ? {
      dataUrl: `data:image/jpeg;base64,${screenshot.jpeg.toString("base64")}`,
      width: screenshot.width,
      height: screenshot.height,
      bytes: screenshot.jpeg.length,
    }
    : null;

  function liveCapture(at: number) {
    if (capture && at - capture.at > CAPTURE_TTL_MS) capture = null;
    return capture;
  }

  if (outboxFiles().length > 0) scheduleRetry();

  return {
    state: () => ({
      available: options.origin !== null,
      queued: outboxFiles().length,
    }),

    capture(screenshot) {
      const at = now();
      capture = { id: randomUUID(), screenshot, at };
      return { captureId: capture.id, screenshot: screenshotView(screenshot), base: base(at) };
    },

    annotate(captureId, screenshot) {
      const held = liveCapture(now());
      if (!screenshot || !held || typeof captureId !== "string" || held.id !== captureId) return null;
      held.screenshot = screenshot;
      return screenshotView(screenshot);
    },

    async send(draft) {
      if (!options.origin) return { result: "unavailable" };
      if (!isPlain(draft)) return { result: "invalid" };
      const at = now();
      const held = liveCapture(at);
      const wantsScreenshot = typeof draft.captureId === "string" && draft.captureId !== "";
      if (wantsScreenshot && (!held || held.id !== draft.captureId)) return { result: "invalid" };
      const shot = wantsScreenshot ? held!.screenshot : null;
      const technical = isPlain(draft.technical) ? draft.technical : null;
      const fromWeb = technical && isPlain(technical.settings) ? technical.settings : {};
      const app = appInfo();
      const feedback = composeFeedback({
        now: at,
        feedbackId: randomUUID(),
        kind: draft.kind,
        text: draft.text,
        contact: draft.contact,
        basics: { version: app.version, channel: app.channel, edition: app.edition, locale: app.locale },
        technical: technical
          ? {
            app,
            web: technical.web,
            // Renderer settings are `ui.*`; only the desktop speaks for `desktop.*`.
            settings: {
              ...Object.fromEntries(Object.entries(fromWeb).filter(([key]) => key.startsWith("ui."))),
              ...options.desktopSettings(),
            },
            packages: technical.packages,
            errors: technical.errors,
          }
          : null,
        profile: draft.profile ?? null,
        screenshot: shot ? { type: "image/jpeg", width: shot.width, height: shot.height, data: shot.jpeg.toString("base64") } : null,
        dailyInstall: dailyInstallId(store.secret, at),
        personInstall: store.person,
      });
      if (!feedback) return { result: "invalid" };
      const answer = await sendOne(feedback);
      if (answer.result === "retry") {
        enqueue(feedback);
        remember(feedback);
        if (held?.id === draft.captureId) capture = null;
        return { result: "queued" };
      }
      if (answer.result === "received") {
        remember(feedback);
        if (held?.id === draft.captureId) capture = null;
        void flushOutbox();
      }
      return answer;
    },

    async forget() {
      const answer = await post("/v1/feedback/forget", { version: 1, install: store.person });
      if (!answer || answer.status !== 200 || !isPlain(answer.body) || answer.body.result !== "forgotten") return { result: "unavailable" };
      const count = Number.isInteger(answer.body.count) ? answer.body.count as number : 0;
      // Feedback still waiting under the old pseudonym goes with it.
      for (const name of outboxFiles()) {
        try {
          const waiting = JSON.parse(readFileSync(join(outboxDir, name), "utf8")) as { install?: unknown };
          if (waiting.install === store.person) rmSync(join(outboxDir, name), { force: true });
        } catch { /* unreadable: the flush drops it */ }
      }
      store = { secret: store.secret, person: randomBytes(16).toString("hex") };
      writeStore();
      return { result: "forgotten", count };
    },

    flushOutbox,

    dispose() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      capture = null;
    },
  };
}

/** Electron's locale (`en-US`, `uk`) as the wire's language tag. */
function localeTag(raw: string): string {
  const tag = raw.replace(/_/g, "-");
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(tag) ? tag : "en";
}
