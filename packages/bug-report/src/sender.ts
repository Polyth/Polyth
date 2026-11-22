// Nightly bug reports from a page opened in a browser
// (docs/dev/desktop.md#bug-reports-nightly). The desktop shell sends its own
// window's reports; a browser has no shell, so its Polyth server does it: the
// page hands over the draft with the screenshot it captured, and this module
// adds what only the server knows (its version and OS, the daily install id),
// validates the whole report against the shared wire shape and sends it to the
// report relay with the tester password the server keeps. Node only; `fetch`,
// the clock and the log come in, so the logic is unit-tested.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUG_REPORT_VERSION,
  isTesterPassword,
  parseBugReport,
  type BugReportBrowserApp,
  type BugReportBrowserPlatform,
  type BugReportPayload,
  type BugReportPlatform,
} from "@polyth/contracts/bug-report";

export const DEFAULT_BUG_REPORT_ORIGIN = "https://reports.polyth.app";
const MINUTE = 60_000;
/** Reports kept waiting for the relay at most; the oldest goes first. */
const OUTBOX_MAX = 10;
const OUTBOX_RETRY_MS = 15 * MINUTE;
const SEND_TIMEOUT_MS = 30_000;

/** Where this server sends reports, or null when it sends none. Only a
 *  nightly server of the standard edition reports, and never a hosted
 *  multi-tenant one: its tester password would be shared by strangers.
 *  `POLYTH_BUG_REPORT=1` turns it on for a development server (the relay still
 *  refuses an unpublished version); `POLYTH_BUG_REPORT_ORIGIN` points at
 *  another relay (`https:` or loopback `http:`), `off` turns it off. */
export function serverBugReportOrigin(input: {
  version: string | undefined;
  workstation: boolean;
  multiTenant: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (input.workstation || input.multiTenant || !input.version) return null;
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

/** 32 hex that change every UTC day: the relay can group one server's
 *  reports within a day, and nobody can link two days of reports to it. */
export function dailyInstallId(secretHex: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(day).digest("hex").slice(0, 32);
}

export type ServerReportOutcome =
  | { result: "created" | "added"; issue: number }
  | { result: "queued" | "password" | "version" | "invalid" | "unavailable" };

export interface ServerReportState {
  available: boolean;
  needsPassword: boolean;
  queued: number;
  /** What the server adds to every report; the sheet shows it. */
  base: {
    version: string;
    channel: BugReportBrowserApp["channel"];
    serverPlatform: BugReportPlatform;
    serverArch: string;
    install: string;
  } | null;
}

export interface ServerReporterOptions {
  /** The package's data folder: the state file and the outbox live here. */
  dir: string;
  origin: string | null;
  version: string;
  platform: string;
  arch: string;
  fetch: typeof fetch;
  now?: () => number;
  log: (message: string, detail?: unknown) => void;
}

export interface ServerReporter {
  state(): ServerReportState;
  send(draft: unknown): Promise<ServerReportOutcome>;
  flushOutbox(): Promise<void>;
  dispose(): void;
}

interface StateFile {
  /** 64 hex: the secret the daily install id is derived from. */
  secret: string;
  /** The tester password the relay last accepted (or that a queued report
   *  needs). The file is 0600 in a 0700 folder; servers have no keychain. */
  password?: string;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BROWSER_PLATFORMS: readonly BugReportBrowserPlatform[] = ["darwin", "win32", "linux", "android", "ios", "unknown"];

const serverPlatform = (platform: string): BugReportPlatform | null =>
  platform === "darwin" || platform === "win32" || platform === "linux" ? platform : null;

type RelayAnswer = ServerReportOutcome | { result: "retry" };

export function createServerReporter(options: ServerReporterOptions): ServerReporter {
  const now = options.now ?? Date.now;
  const statePath = join(options.dir, "state.json");
  const outboxDir = join(options.dir, "outbox");
  const platform = serverPlatform(options.platform);
  // A server on another OS cannot fill the wire's server platform.
  const origin = platform ? options.origin : null;
  let stored = readState();
  let retryTimer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;
  let disposed = false;

  function readState(): StateFile {
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
      if (isPlain(raw) && typeof raw.secret === "string" && /^[0-9a-f]{64}$/.test(raw.secret)) {
        return {
          secret: raw.secret,
          ...(isTesterPassword(raw.password) ? { password: raw.password } : {}),
        };
      }
    } catch { /* first run, or an unreadable file: start again */ }
    return { secret: randomBytes(32).toString("hex") };
  }

  function writeState(): void {
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      const temp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, statePath);
    } catch (error) {
      options.log("Could not save the bug report state", error instanceof Error ? error.message : undefined);
    }
  }

  function rememberPassword(value: string): void {
    if (stored.password === value) return;
    stored = { ...stored, password: value };
    writeState();
  }

  function forgetPassword(): void {
    if (!stored.password) return;
    stored = { secret: stored.secret };
    writeState();
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
      options.log("Could not keep the bug report for later", error instanceof Error ? error.message : undefined);
    }
    scheduleRetry();
  }

  function scheduleRetry(): void {
    if (disposed || retryTimer || outboxFiles().length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flushOutbox();
    }, OUTBOX_RETRY_MS);
    retryTimer.unref?.();
  }

  async function post(report: BugReportPayload, secret: string): Promise<RelayAnswer> {
    if (!origin) return { result: "unavailable" };
    let response: Response;
    try {
      response = await options.fetch(new URL("/v1/report", origin).toString(), {
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
        if (disposed) break;
        const path = join(outboxDir, name);
        let report: BugReportPayload | null = null;
        try { report = parseBugReport(JSON.parse(readFileSync(path, "utf8")) as unknown, now()); } catch { report = null; }
        if (!report) { rmSync(path, { force: true }); continue; }
        if (!stored.password) break;
        const answer = await post(report, stored.password);
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

  const channel = (): BugReportBrowserApp["channel"] => options.version.endsWith("-nightly") ? "nightly" : "stable";

  if (outboxFiles().length > 0) scheduleRetry();

  return {
    state: () => ({
      available: origin !== null,
      needsPassword: !stored.password,
      queued: outboxFiles().length,
      base: origin && platform
        ? { version: options.version, channel: channel(), serverPlatform: platform, serverArch: options.arch, install: dailyInstallId(stored.secret, now()) }
        : null,
    }),

    async send(draft) {
      if (!origin || !platform) return { result: "unavailable" };
      if (!isPlain(draft)) return { result: "invalid" };
      const typed = typeof draft.password === "string" ? draft.password.trim() : "";
      // The relay could never take it (a header carries printable ASCII only).
      if (typed && !isTesterPassword(typed)) return { result: "password" };
      const secret = typed || stored.password;
      if (!secret) return { result: "password" };
      const at = now();
      const client = isPlain(draft.client) ? draft.client : {};
      const browserPlatform = BROWSER_PLATFORMS.includes(client.platform as BugReportBrowserPlatform)
        ? client.platform as BugReportBrowserPlatform
        : "unknown";
      const fromPage = isPlain(draft.settings) ? draft.settings : {};
      const report = parseBugReport({
        version: BUG_REPORT_VERSION,
        reportId: randomUUID(),
        install: dailyInstallId(stored.secret, at),
        createdAt: new Date(at).toISOString(),
        // The server speaks for its own version and OS; the page only for
        // the browser it runs in.
        app: {
          client: "browser",
          version: options.version,
          channel: channel(),
          edition: "standard",
          platform: browserPlatform,
          browser: client.browser,
          serverPlatform: platform,
          serverArch: options.arch,
          locale: client.locale,
        },
        web: draft.web,
        // A page speaks only for `ui.*` settings.
        settings: Object.fromEntries(Object.entries(fromPage).filter(([key]) => key.startsWith("ui."))),
        packages: draft.packages,
        errors: draft.errors,
        text: typeof draft.text === "string" ? draft.text.trim() : draft.text,
        contact: typeof draft.contact === "string" ? draft.contact.trim().replace(/^@/, "") : draft.contact,
        screenshot: draft.screenshot ?? null,
      }, at);
      if (!report) return { result: "invalid" };
      const answer = await post(report, secret);
      if (answer.result === "password") {
        // A kept password the relay no longer takes is dropped; a typed one
        // was never kept.
        if (!typed) forgetPassword();
        return answer;
      }
      if (answer.result === "retry") {
        // Unverified, but the queued report needs it to go later. It never
        // replaces a kept one: anyone signed in could otherwise swap the
        // server's working password for a wrong one while the relay is down.
        if (typed && !stored.password) rememberPassword(typed);
        enqueue(report);
        return { result: "queued" };
      }
      if (answer.result === "created" || answer.result === "added") {
        if (typed) rememberPassword(typed);
        void flushOutbox();
      }
      return answer;
    },

    flushOutbox,

    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
