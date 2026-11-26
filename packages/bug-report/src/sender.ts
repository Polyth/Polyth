// Feedback from a page opened in a browser (docs/dev/desktop.md#feedback). The
// desktop shell sends its own window's feedback; a browser has no shell, so its
// Polyth server does it: the page hands over the draft with the screenshot it
// captured, and this module adds what only the server knows (its version and
// OS, the two pseudonyms), validates the whole feedback against the shared wire
// shape (`composeFeedback`) and sends it to the intake. There is no password and
// no account. Node only; `fetch`, the clock and the log come in, so the logic is
// unit-tested.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BugReportBrowserPlatform, BugReportPlatform } from "@polyth/contracts/bug-report";
import {
  FEEDBACK_EXPERIENCE,
  FEEDBACK_ROLES,
  composeFeedback,
  parseFeedback,
  type FeedbackPayload,
  type FeedbackProfile,
} from "@polyth/contracts/feedback";

export const DEFAULT_BUG_REPORT_ORIGIN = "https://reports.polyth.app";
const MINUTE = 60_000;
/** Feedback kept waiting for the intake at most; the oldest goes first. */
const OUTBOX_MAX = 10;
const OUTBOX_RETRY_MS = 15 * MINUTE;
const SEND_TIMEOUT_MS = 30_000;

/** Where this server sends feedback, or null when it sends none. Never a
 *  workstation server (there only the desktop shell sends) and never a hosted
 *  multi-tenant one: strangers would share one source.
 *  `POLYTH_BUG_REPORT_ORIGIN` points at another intake (`https:` or loopback
 *  `http:`), `off` turns it off. */
export function serverBugReportOrigin(input: {
  version: string | undefined;
  workstation: boolean;
  multiTenant: boolean;
  env: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (input.workstation || input.multiTenant || !input.version) return null;
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
 *  feedback to one server. */
export function dailyInstallId(secretHex: string, now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return createHmac("sha256", Buffer.from(secretHex, "hex")).update(day).digest("hex").slice(0, 32);
}

export type ServerFeedbackOutcome =
  | { result: "received"; ref: number }
  | { result: "queued" | "rate" | "invalid" | "unavailable" };

export interface ServerReportState {
  available: boolean;
  queued: number;
  /** What the server adds to every feedback; the sheet shows it. */
  base: {
    version: string;
    channel: "nightly" | "stable";
    serverPlatform: BugReportPlatform;
    serverArch: string;
    /** The pseudonym that changes every day (anonymous feedback). */
    installDaily: string;
    /** The pseudonym the person can reset (sent only with a profile or contact). */
    installPerson: string;
    /** The profile the person saved with an earlier feedback, to prefill. */
    savedProfile: FeedbackProfile | null;
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
  send(draft: unknown): Promise<ServerFeedbackOutcome>;
  /** Erases what this server sent under its resettable pseudonym and starts a
   *  new one. */
  forget(): Promise<{ result: "forgotten"; count: number } | { result: "unavailable" }>;
  flushOutbox(): Promise<void>;
  dispose(): void;
}

interface StateFile {
  /** 64 hex: the secret the daily pseudonym is derived from. */
  secret: string;
  /** 32 hex: the pseudonym the person can reset. */
  person: string;
  profile?: FeedbackProfile;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BROWSER_PLATFORMS: readonly BugReportBrowserPlatform[] = ["darwin", "win32", "linux", "android", "ios", "unknown"];

const serverPlatform = (platform: string): BugReportPlatform | null =>
  platform === "darwin" || platform === "win32" || platform === "linux" ? platform : null;

const asProfile = (value: unknown): FeedbackProfile | undefined =>
  isPlain(value)
  && (FEEDBACK_ROLES as readonly unknown[]).includes(value.role)
  && (FEEDBACK_EXPERIENCE as readonly unknown[]).includes(value.experience)
    ? { role: value.role as FeedbackProfile["role"], experience: value.experience as FeedbackProfile["experience"] }
    : undefined;

type Answer = ServerFeedbackOutcome | { result: "retry" };

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

  function writeState(): void {
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      const temp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, statePath);
    } catch (error) {
      options.log("Could not save the feedback state", error instanceof Error ? error.message : undefined);
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
      options.log("Could not keep the feedback for later", error instanceof Error ? error.message : undefined);
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

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
    if (!origin) return null;
    try {
      const response = await options.fetch(new URL(path, origin).toString(), {
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
    if (!origin) return { result: "unavailable" };
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
        if (disposed) break;
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

  const channel = (): "nightly" | "stable" => options.version.endsWith("-nightly") ? "nightly" : "stable";

  /** The profile the person shared is kept, so the next sheet opens with it. */
  function remember(feedback: FeedbackPayload): void {
    if (feedback.profile && JSON.stringify(stored.profile) !== JSON.stringify(feedback.profile)) {
      stored = { ...stored, profile: feedback.profile };
      writeState();
    }
  }

  if (outboxFiles().length > 0) scheduleRetry();

  return {
    state: () => ({
      available: origin !== null,
      queued: outboxFiles().length,
      base: origin && platform
        ? {
          version: options.version,
          channel: channel(),
          serverPlatform: platform,
          serverArch: options.arch,
          installDaily: dailyInstallId(stored.secret, now()),
          installPerson: stored.person,
          savedProfile: stored.profile ?? null,
        }
        : null,
    }),

    async send(draft) {
      if (!origin || !platform) return { result: "unavailable" };
      if (!isPlain(draft)) return { result: "invalid" };
      const at = now();
      const client = isPlain(draft.client) ? draft.client : {};
      const browserPlatform = BROWSER_PLATFORMS.includes(client.platform as BugReportBrowserPlatform)
        ? client.platform as BugReportBrowserPlatform
        : "unknown";
      const technical = isPlain(draft.technical) ? draft.technical : null;
      const fromPage = technical && isPlain(technical.settings) ? technical.settings : {};
      const locale = client.locale;
      const feedback = composeFeedback({
        now: at,
        feedbackId: randomUUID(),
        kind: draft.kind,
        text: draft.text,
        contact: draft.contact,
        basics: { version: options.version, channel: channel(), edition: "standard", locale: typeof locale === "string" ? locale : "" },
        // The server speaks for its own version and OS; the page only for the
        // browser it runs in and for `ui.*` settings.
        technical: technical
          ? {
            app: {
              client: "browser",
              version: options.version,
              channel: channel(),
              edition: "standard",
              platform: browserPlatform,
              browser: client.browser,
              serverPlatform: platform,
              serverArch: options.arch,
              locale,
            },
            web: technical.web,
            settings: Object.fromEntries(Object.entries(fromPage).filter(([key]) => key.startsWith("ui."))),
            packages: technical.packages,
            errors: technical.errors,
          }
          : null,
        profile: draft.profile ?? null,
        screenshot: (isPlain(draft.screenshot) ? draft.screenshot : null) as FeedbackPayload["screenshot"],
        dailyInstall: dailyInstallId(stored.secret, at),
        personInstall: stored.person,
      });
      if (!feedback) return { result: "invalid" };
      const answer = await sendOne(feedback);
      if (answer.result === "retry") {
        enqueue(feedback);
        remember(feedback);
        return { result: "queued" };
      }
      if (answer.result === "received") {
        remember(feedback);
        void flushOutbox();
      }
      return answer;
    },

    async forget() {
      const answer = await post("/v1/feedback/forget", { version: 1, install: stored.person });
      if (!answer || answer.status !== 200 || !isPlain(answer.body) || answer.body.result !== "forgotten") return { result: "unavailable" };
      const count = Number.isInteger(answer.body.count) ? answer.body.count as number : 0;
      // Feedback still waiting under the old pseudonym goes with it.
      for (const name of outboxFiles()) {
        try {
          const waiting = JSON.parse(readFileSync(join(outboxDir, name), "utf8")) as { install?: unknown };
          if (waiting.install === stored.person) rmSync(join(outboxDir, name), { force: true });
        } catch { /* unreadable: the flush drops it */ }
      }
      stored = { secret: stored.secret, person: randomBytes(16).toString("hex") };
      writeState();
      return { result: "forgotten", count };
    },

    flushOutbox,

    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
