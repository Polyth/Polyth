// Nightly bug reports (docs/dev/desktop.md#bug-reports-nightly). The renderer's
// report sheet asks for a capture, shows the person exactly what goes, and
// hands back a draft; this module adds what only the desktop knows (build,
// desktop settings, the daily install id), validates the whole report against
// the shared wire shape and sends it to the report relay with the tester
// password. Nothing here imports Electron: main.ts passes the screenshot,
// OS encryption and `net.fetch` in, so the logic is unit-tested.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUG_REPORT_LIMITS,
  BUG_REPORT_VERSION,
  isTesterPassword,
  parseBugReport,
  type BugReportApp,
  type BugReportPayload,
  type BugReportSettingValue,
} from "@polyth/contracts/bug-report";
import type { PolythEdition } from "@polyth/contracts/edition";

import type { DesktopBugReportCapture, DesktopBugReportOutcome, DesktopBugReportState } from "./types.ts";

export const DEFAULT_BUG_REPORT_ORIGIN = "https://reports.polyth.app";
const MINUTE = 60_000;
/** Reports kept waiting for the relay at most; the oldest goes first. */
const OUTBOX_MAX = 10;
const OUTBOX_RETRY_MS = 15 * MINUTE;
const CAPTURE_TTL_MS = 15 * MINUTE;
const SEND_TIMEOUT_MS = 30_000;
const JPEG_QUALITIES = [80, 70, 60, 50] as const;

/** Where reports go, or null when this build sends none. Only nightly builds
 *  of the standard edition report; `POLYTH_BUG_REPORT=1` turns it on for a
 *  development build (the relay still refuses an unpublished version).
 *  `POLYTH_BUG_REPORT_ORIGIN` points at another relay, `off` turns it off. */
export function bugReportOrigin(input: {
  version: string;
  edition: PolythEdition;
  env: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (input.edition === "workstation") return null;
  const raw = input.env.POLYTH_BUG_REPORT_ORIGIN?.trim();
  if (raw === "off") return null;
  if (!input.version.endsWith("-nightly") && input.env.POLYTH_BUG_REPORT !== "1") return null;
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

/** 32 hex that change every UTC day: the relay can count one computer's
 *  reports per day, and nobody can link two days of reports to it. */
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
  /** 64 hex: the secret the daily install id is derived from. */
  secret: string;
  /** The tester password as the OS encryption returned it (base64). */
  password?: string;
}

export interface BugReportClientOptions {
  /** `<userData>/desktop`: the store file and the outbox live here. */
  dir: string;
  origin: string | null;
  app: Omit<BugReportApp, "channel" | "locale">;
  locale: () => string;
  /** What the desktop adds to the settings: `desktop.*` keys. */
  desktopSettings: () => Record<string, BugReportSettingValue>;
  /** OS encryption (Electron `safeStorage`); null when unavailable, and the
   *  password then lives only for this run. */
  encrypt: (plain: string) => string | null;
  decrypt: (stored: string) => string | null;
  fetch: typeof fetch;
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

export interface BugReportClient {
  state(): DesktopBugReportState;
  capture(screenshot: EncodedScreenshot | null): DesktopBugReportCapture;
  send(draft: unknown): Promise<DesktopBugReportOutcome>;
  flushOutbox(): Promise<void>;
  dispose(): void;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type RelayAnswer = DesktopBugReportOutcome | { result: "retry" };

export function createBugReportClient(options: BugReportClientOptions): BugReportClient {
  const now = options.now ?? Date.now;
  const storePath = join(options.dir, "bug-report.json");
  const outboxDir = join(options.dir, "bug-reports");
  let store = readStore();
  /** The password for this run: typed now or decrypted from the store. */
  let password: string | null = store.password ? options.decrypt(store.password) : null;
  let capture: { id: string; screenshot: EncodedScreenshot | null; at: number } | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;

  function readStore(): StoreFile {
    try {
      const raw = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
      if (isPlain(raw) && typeof raw.secret === "string" && /^[0-9a-f]{64}$/.test(raw.secret)) {
        return {
          secret: raw.secret,
          ...(typeof raw.password === "string" && raw.password ? { password: raw.password } : {}),
        };
      }
    } catch { /* first run, or an unreadable file: start again */ }
    return { secret: randomBytes(32).toString("hex") };
  }

  function writeStore(): void {
    try {
      mkdirSync(options.dir, { recursive: true });
      const temp = `${storePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(store)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, storePath);
    } catch (error) {
      options.log("Could not save the bug report state", error);
    }
  }

  function rememberPassword(value: string): void {
    password = value;
    const sealed = options.encrypt(value);
    if (sealed) store.password = sealed;
    else delete store.password;
    writeStore();
  }

  function forgetPassword(): void {
    password = null;
    if (store.password) {
      delete store.password;
      writeStore();
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

  function enqueue(report: BugReportPayload): void {
    try {
      mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
      const path = join(outboxDir, `${report.reportId}.json`);
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(report), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
      const files = outboxFiles();
      for (const name of files.slice(0, Math.max(0, files.length - OUTBOX_MAX))) rmSync(join(outboxDir, name), { force: true });
    } catch (error) {
      options.log("Could not keep the bug report for later", error);
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

  async function post(report: BugReportPayload, secret: string): Promise<RelayAnswer> {
    if (!options.origin) return { result: "unavailable" };
    let response: Response;
    try {
      response = await options.fetch(new URL("/v1/report", options.origin).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      options.log("The bug report relay could not be reached", error instanceof Error ? error.name : undefined);
      return { result: "retry" };
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* answered below by status */ }
    const result = isPlain(body) ? body.result : undefined;
    const issue = isPlain(body) && Number.isInteger(body.issue) && (body.issue as number) > 0 ? body.issue as number : 0;
    if (response.status === 200 && (result === "created" || result === "added") && issue) return { result, issue };
    if (response.status === 401) return { result: "password" };
    if (response.status === 422) return { result: "version" };
    if (response.status === 400) return { result: "invalid" };
    // A limit, an overloaded relay or GitHub being down: it goes later.
    return { result: "retry" };
  }

  async function flushOutbox(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      for (const name of outboxFiles()) {
        const path = join(outboxDir, name);
        let report: BugReportPayload | null = null;
        try { report = parseBugReport(JSON.parse(readFileSync(path, "utf8")) as unknown, now()); } catch { report = null; }
        if (!report) { rmSync(path, { force: true }); continue; }
        if (!password) break;
        const answer = await post(report, password);
        if (answer.result === "retry") break;
        if (answer.result === "password") { forgetPassword(); break; }
        // Sent, or refused for good (an unpublished version, a stale shape).
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
      install: dailyInstallId(store.secret, at),
      settings: options.desktopSettings(),
    };
  }

  function appInfo(): BugReportApp {
    return {
      ...options.app,
      channel: options.app.version.endsWith("-nightly") ? "nightly" : "stable",
      locale: localeTag(options.locale()),
    };
  }

  function liveCapture(at: number) {
    if (capture && at - capture.at > CAPTURE_TTL_MS) capture = null;
    return capture;
  }

  if (outboxFiles().length > 0) scheduleRetry();

  return {
    state: () => ({
      available: options.origin !== null,
      needsPassword: password === null,
      queued: outboxFiles().length,
    }),

    capture(screenshot) {
      const at = now();
      capture = { id: randomUUID(), screenshot, at };
      return {
        captureId: capture.id,
        screenshot: screenshot
          ? {
            dataUrl: `data:image/jpeg;base64,${screenshot.jpeg.toString("base64")}`,
            width: screenshot.width,
            height: screenshot.height,
            bytes: screenshot.jpeg.length,
          }
          : null,
        base: base(at),
        needsPassword: password === null,
        passwordStorage: options.encrypt("probe") === null ? "session" : "keychain",
      };
    },

    async send(draft) {
      if (!options.origin) return { result: "unavailable" };
      if (!isPlain(draft)) return { result: "invalid" };
      const typed = typeof draft.password === "string" ? draft.password.trim() : "";
      // The relay could never take it (a header carries printable ASCII only).
      if (typed && !isTesterPassword(typed)) return { result: "password" };
      const secret = typed || password;
      if (!secret) return { result: "password" };
      const at = now();
      const held = liveCapture(at);
      const wantsScreenshot = typeof draft.captureId === "string" && draft.captureId !== "";
      if (wantsScreenshot && (!held || held.id !== draft.captureId)) return { result: "invalid" };
      const shot = wantsScreenshot ? held!.screenshot : null;
      const fromWeb = isPlain(draft.settings) ? draft.settings : {};
      const report = parseBugReport({
        version: BUG_REPORT_VERSION,
        reportId: randomUUID(),
        ...base(at),
        createdAt: new Date(at).toISOString(),
        web: draft.web,
        // Renderer settings are `ui.*`; only the desktop speaks for `desktop.*`.
        settings: {
          ...Object.fromEntries(Object.entries(fromWeb).filter(([key]) => key.startsWith("ui."))),
          ...options.desktopSettings(),
        },
        packages: draft.packages,
        errors: draft.errors,
        text: typeof draft.text === "string" ? draft.text.trim() : draft.text,
        contact: typeof draft.contact === "string" ? draft.contact.trim().replace(/^@/, "") : draft.contact,
        screenshot: shot ? { type: "image/jpeg", width: shot.width, height: shot.height, data: shot.jpeg.toString("base64") } : null,
      }, at);
      if (!report) return { result: "invalid" };
      const answer = await post(report, secret);
      if (answer.result === "password") {
        // A stored password the relay no longer takes is dropped; a typed one
        // was never kept.
        if (!typed) forgetPassword();
        return answer;
      }
      if (answer.result === "retry") {
        // Unverified, but the queued report needs it to go later.
        if (typed && typed !== password) rememberPassword(typed);
        enqueue(report);
        if (held?.id === draft.captureId) capture = null;
        return { result: "queued" };
      }
      if (answer.result === "created" || answer.result === "added") {
        if (typed && typed !== password) rememberPassword(typed);
        if (held?.id === draft.captureId) capture = null;
        void flushOutbox();
      }
      return answer;
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
