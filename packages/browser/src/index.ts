// Controlled browser service (WP14): one isolated context per browser session
// shared by the user and the agent, revisioned frames with newest-only
// delivery, URL policy on every hop, redacted observations, honest
// capability reporting when no engine is available.
import { randomUUID } from "node:crypto";
import type {
  BrowserAction,
  BrowserColorScheme,
  BrowserObservation,
  BrowserSessionDto,
  BrowserTarget,
  Disposable,
  JsonObject,
  JsonValue,
} from "@polyth/contracts";
import type { BrowserDriver, DriverPage, DriverPageEvent } from "./driver.ts";
import { checkUrl, isLoopbackAddress, isLoopbackHost, originOf, type UrlPolicyOptions } from "./policy.ts";
import { redactObservationText } from "./redact.ts";

export type { BrowserDriver, DriverPage, DriverPageEvent, DriverObservation, DriverNav, DriverOpenOptions } from "./driver.ts";
export { createFakeDriver, demoWeb, type FakeWeb, type FakePage } from "./fake.ts";
export { checkUrl, isLoopbackHost, isPrivateAddress, isLoopbackAddress, originAliases, originOf, type UrlDecision, type UrlPolicyOptions, type Resolver } from "./policy.ts";
export { redactObservationText, type RedactOptions } from "./redact.ts";
export { createChromiumDriver, findChromiumExecutable, CHROMIUM_CANDIDATE_PATHS } from "./chromium.ts";

export interface BrowserFrame {
  browserSessionId: string;
  revision: number;
  mime: string;
  data: Uint8Array;
}

export interface BrowserRuntimeEvent {
  browserSessionId: string;
  kind: string;
  message?: string;
  url?: string;
  level?: string;
  actor?: "user" | "agent";
  actionId?: string;
}

export interface BrowserCapability {
  available: boolean;
  engine: "chromium" | "fake" | null;
  reason?: string;
}

export interface BrowserCreateInput {
  projectId: string;
  sessionId?: string;
  url?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  colorScheme?: BrowserColorScheme;
}

export interface BrowserObserveOptions {
  includeScreenshot?: boolean;
  selector?: string;
}

export interface ObservationWithShot extends BrowserObservation {
  screenshot?: { data: Uint8Array; mime: string };
}

export interface BrowserServiceOptions {
  driver: BrowserDriver | null;
  /** Honest reason shown when driver is null ("browser engine unavailable…"). */
  unavailableReason?: string;
  /** Origins Polyth started (dev preview) — allowed loopback targets. */
  allowedOrigins?: () => string[];
  resolve?: UrlPolicyOptions["resolve"];
  secrets?: ReadonlyArray<string>;
  maxSessions?: number;
  maxLifetimeMs?: number;
  maxConsoleEntries?: number;
  maxObservationChars?: number;
  actionTimeoutMs?: number;
}

export interface BrowserService {
  capability(): BrowserCapability;
  create(input: BrowserCreateInput): Promise<BrowserSessionDto>;
  get(id: string): BrowserSessionDto | null;
  list(): BrowserSessionDto[];
  navigate(id: string, url: string, actor: "user" | "agent"): Promise<BrowserSessionDto>;
  action(id: string, action: BrowserAction, actor: "user" | "agent"): Promise<{ actionId: string; session: BrowserSessionDto; result?: JsonObject }>;
  observe(id: string, opts?: BrowserObserveOptions): Promise<ObservationWithShot>;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  pauseAgent(id: string, paused: boolean): void;
  agentPaused(id: string): boolean;
  approveOrigin(origin: string): void;
  approvals(): string[];
  console(id: string): Array<{ at: number; level: string; message: string }>;
  latestFrame(id: string, afterRevision?: number): BrowserFrame | null;
  onFrame(cb: (frame: BrowserFrame) => void): Disposable;
  onEvent(cb: (event: BrowserRuntimeEvent) => void): Disposable;
}

interface SessionState {
  dto: BrowserSessionDto;
  page: DriverPage;
  queue: Promise<unknown>;
  agentPaused: boolean;
  consoleBuf: Array<{ at: number; level: string; message: string }>;
  frame: BrowserFrame | null;
  lifetimeTimer: ReturnType<typeof setTimeout>;
  disposeDriverEvents: () => void;
}

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const redactJsonValue = (value: JsonValue, secrets: ReadonlyArray<string>): JsonValue => {
  if (typeof value === "string") {
    return redactObservationText(value, { secrets, maxChars: 2_000 });
  }
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item, secrets)]),
    );
  }
  return value;
};

const redactJsonObject = (value: JsonObject, secrets: ReadonlyArray<string>): JsonObject =>
  redactJsonValue(value, secrets) as JsonObject;

export function createBrowserService(opts: BrowserServiceOptions): BrowserService {
  const driver = opts.driver;
  const maxSessions = opts.maxSessions ?? 4;
  const maxLifetimeMs = opts.maxLifetimeMs ?? 30 * 60_000;
  const maxConsole = opts.maxConsoleEntries ?? 200;
  const actionTimeoutMs = opts.actionTimeoutMs ?? 20_000;
  const sessions = new Map<string, SessionState>();
  const approved = new Set<string>();
  const frameCbs = new Set<(f: BrowserFrame) => void>();
  const eventCbs = new Set<(e: BrowserRuntimeEvent) => void>();

  const policyOpts = (): UrlPolicyOptions => ({
    allowedOrigins: opts.allowedOrigins?.() ?? [],
    approvedOrigins: approved,
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
  });

  const emit = (e: BrowserRuntimeEvent) => { for (const cb of [...eventCbs]) cb(e); };

  const stateOf = (id: string): SessionState => {
    const s = sessions.get(id);
    if (!s || s.dto.status === "closed") throw err("not-found", `no browser session ${id}`);
    return s;
  };

  const captureFrame = async (s: SessionState): Promise<void> => {
    try {
      const shot = await s.page.screenshot();
      s.dto.revision += 1;
      s.frame = { browserSessionId: s.dto.id, revision: s.dto.revision, mime: shot.mime, data: shot.data };
      for (const cb of [...frameCbs]) cb(s.frame);
    } catch {
      // screenshot failure is non-fatal; revision only moves with a frame
    }
  };

  const syncNav = (s: SessionState): void => {
    const cur = s.page.current();
    s.dto.url = cur.url;
    s.dto.title = cur.title;
  };

  /** Serialize user+agent work on one session; a shared queue is what makes
   *  "user and agent operate the same context" safe. */
  const enqueue = <T>(s: SessionState, work: () => Promise<T>): Promise<T> => {
    const run = s.queue.then(work, work);
    s.queue = run.catch(() => undefined);
    return run;
  };

  const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(err("timeout", `${what} timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const doClose = async (id: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    clearTimeout(s.lifetimeTimer);
    s.disposeDriverEvents();
    s.dto.status = "closed";
    s.frame = null; // captured frames die with the session
    try { await s.page.close(); } catch { /* already gone */ }
    emit({ browserSessionId: id, kind: "closed" });
  };

  const service: BrowserService = {
    capability() {
      if (!driver) {
        return { available: false, engine: null, reason: opts.unavailableReason ?? "browser engine unavailable: no Chromium executable configured (set POLYTH_CHROMIUM_PATH)" };
      }
      return { available: true, engine: driver.engine };
    },

    async create(input) {
      if (!driver) throw err("unavailable", service.capability().reason ?? "browser engine unavailable");
      if (sessions.size >= maxSessions) throw err("limit", `too many browser sessions (max ${maxSessions})`);
      const id = randomUUID();
      const viewport = {
        width: Math.min(input.viewport?.width ?? 1280, 3840),
        height: Math.min(input.viewport?.height ?? 800, 2160),
        deviceScaleFactor: input.viewport?.deviceScaleFactor ?? 1,
      };
      const dto: BrowserSessionDto = {
        id,
        projectId: input.projectId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        url: "about:blank",
        title: "",
        status: "starting",
        viewport,
        colorScheme: input.colorScheme ?? "no-preference",
        revision: 0,
        engine: driver.engine,
      };
      const page = await driver.open({
        ...viewport,
        colorScheme: dto.colorScheme,
        guardNavigation: async (url) => {
          let decision = await checkUrl(url, policyOpts());
          if (!decision.ok && decision.code === "approval-required") {
            try {
              const parsed = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`);
              const host = parsed.hostname.toLowerCase();
              const loopback = isLoopbackHost(host)
                || (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isLoopbackAddress(host));
              if (!loopback) {
                const o = originOf(url);
                if (o) {
                  approved.add(o);
                  decision = await checkUrl(url, policyOpts());
                }
              }
            } catch { /* fall through to block */ }
          }
          if (!decision.ok) {
            emit({ browserSessionId: id, kind: "navigation-blocked", url, message: decision.reason });
            throw err(decision.code, decision.reason);
          }
        },
      });
      const s: SessionState = {
        dto,
        page,
        queue: Promise.resolve(),
        agentPaused: false,
        consoleBuf: [],
        frame: null,
        lifetimeTimer: setTimeout(() => void doClose(id), maxLifetimeMs),
        disposeDriverEvents: () => {},
      };
      s.lifetimeTimer.unref?.();
      s.disposeDriverEvents = page.onEvent((ev: DriverPageEvent) => {
        if (ev.kind === "console") {
          s.consoleBuf.push({ at: Date.now(), level: ev.level ?? "log", message: redactObservationText(ev.message ?? "", { secrets: opts.secrets ?? [], maxChars: 2000 }) });
          if (s.consoleBuf.length > maxConsole) s.consoleBuf.splice(0, s.consoleBuf.length - maxConsole);
        }
        // High-frequency noise stays UI-side; the gateway decides what to fan out.
        emit({
          browserSessionId: id,
          kind: ev.kind,
          ...(ev.message !== undefined
            ? { message: redactObservationText(ev.message, { secrets: opts.secrets ?? [], maxChars: 2_000 }) }
            : {}),
          ...(ev.url !== undefined ? { url: ev.url } : {}),
          ...(ev.level !== undefined ? { level: ev.level } : {}),
        });
      });
      sessions.set(id, s);
      dto.status = "ready";
      if (input.url) {
        try {
          await service.navigate(id, input.url, "user");
        } catch (error) {
          const failure = error as Error & { code?: string };
          if (failure.code !== "approval-required") throw error;
          // Session created but the initial URL needs approval — return the
          // session so the client can show its approval dialog.
          await enqueue(s, () => captureFrame(s));
          return { ...s.dto };
        }
      } else {
        await enqueue(s, () => captureFrame(s));
      }
      return { ...s.dto };
    },

    get(id) {
      const s = sessions.get(id);
      return s ? { ...s.dto } : null;
    },

    list() {
      return [...sessions.values()].map((s) => ({ ...s.dto }));
    },

    async navigate(id, url, actor) {
      const s = stateOf(id);
      if (actor === "agent" && s.agentPaused) throw err("agent-paused", "agent control is paused for this browser session");
      // Fail fast with the policy code; the driver route guard still covers
      // every subsequent hop (redirects, in-page navigations).
      const decision = await checkUrl(url, policyOpts());
      if (!decision.ok) {
        emit({ browserSessionId: id, kind: "navigation-blocked", url, message: decision.reason });
        throw err(decision.code, decision.reason);
      }
      return enqueue(s, async () => {
        await withTimeout(s.page.goto(decision.url), actionTimeoutMs, "navigate");
        syncNav(s);
        await captureFrame(s);
        return { ...s.dto };
      });
    },

    async action(id, action, actor) {
      const s = stateOf(id);
      if (actor === "agent" && s.agentPaused) throw err("agent-paused", "agent control is paused for this browser session");
      const actionId = randomUUID();
      validateTargets(action, s.dto.revision);
      return enqueue(s, async () => {
        emit({ browserSessionId: id, kind: "action", actor, actionId, message: action.kind });
        let result: JsonObject | undefined;
        const work = async (): Promise<void> => {
          switch (action.kind) {
            case "click": return s.page.click(action.target);
            case "point": {
              result = redactJsonObject(await s.page.point(action.target.point), opts.secrets ?? []);
              return;
            }
            case "type": return s.page.type(action.target, action.text, action.submit);
            case "press": return s.page.press(action.key);
            case "scroll": return s.page.scroll(action.x ?? 0, action.y ?? 0, action.target);
            case "select": return s.page.select(action.target, action.value);
            case "wait": return s.page.wait(action.condition, action.value, Math.min(action.timeoutMs ?? actionTimeoutMs, actionTimeoutMs));
            case "back": { await s.page.back(); return; }
            case "forward": { await s.page.forward(); return; }
            case "reload": { await s.page.reload(); return; }
            case "resize": {
              const viewport = {
                width: Math.max(320, Math.min(action.viewport.width, 3840)),
                height: Math.max(240, Math.min(action.viewport.height, 2160)),
              };
              await s.page.resize(viewport);
              s.dto.viewport = { ...s.dto.viewport, ...viewport };
              return;
            }
            case "color-scheme": {
              if (action.colorScheme !== "light" && action.colorScheme !== "dark" && action.colorScheme !== "no-preference") {
                throw err("invalid-input", "colorScheme must be light, dark, or no-preference");
              }
              await s.page.emulateColorScheme(action.colorScheme);
              s.dto.colorScheme = action.colorScheme;
              return;
            }
            case "inspect": {
              result = redactJsonObject(await s.page.inspect(action.selector), opts.secrets ?? []);
              return;
            }
          }
        };
        await withTimeout(work(), actionTimeoutMs, `action ${action.kind}`);
        syncNav(s);
        // Pointing is read-only. Keeping the revision stable means the returned
        // element geometry still describes the frame the user clicked.
        if (action.kind !== "point") await captureFrame(s);
        return { actionId, session: { ...s.dto }, ...(result ? { result } : {}) };
      });
    },

    async observe(id, o = {}) {
      const s = stateOf(id);
      return enqueue(s, async () => {
        const raw = await withTimeout(s.page.observe(o.selector), actionTimeoutMs, "observe");
        const out: ObservationWithShot = {
          url: raw.url,
          title: raw.title,
          text: redactObservationText(raw.text, { secrets: opts.secrets ?? [], maxChars: opts.maxObservationChars ?? 20_000 }),
          accessibilityDigest: redactObservationText(raw.accessibilityDigest, { secrets: opts.secrets ?? [], maxChars: 4_000 }),
        };
        if (o.includeScreenshot) {
          const shot = await s.page.screenshot();
          out.screenshot = shot;
        }
        return out;
      });
    },

    close: doClose,

    async closeAll() {
      await Promise.all([...sessions.keys()].map(doClose));
      await driver?.close();
    },

    pauseAgent(id, paused) {
      const s = stateOf(id);
      s.agentPaused = paused;
      emit({ browserSessionId: id, kind: paused ? "agent-paused" : "agent-resumed" });
    },

    agentPaused(id) {
      return stateOf(id).agentPaused;
    },

    approveOrigin(origin) {
      const o = originOf(origin);
      if (!o) throw err("invalid-input", `not a valid origin: ${origin}`);
      approved.add(o);
    },

    approvals() {
      return [...approved];
    },

    console(id) {
      return [...stateOf(id).consoleBuf];
    },

    latestFrame(id, afterRevision = 0) {
      const s = sessions.get(id);
      if (!s?.frame) return null;
      return s.frame.revision > afterRevision ? s.frame : null;
    },

    onFrame(cb) {
      frameCbs.add(cb);
      return { dispose: () => { frameCbs.delete(cb); } };
    },

    onEvent(cb) {
      eventCbs.add(cb);
      return { dispose: () => { eventCbs.delete(cb); } };
    },
  };

  return service;
}

/** Point targets carry the frame revision they were computed on; a click on a
 *  frame the user/agent is no longer looking at must never land. */
function validateTargets(action: BrowserAction, currentRevision: number): void {
  const targets: BrowserTarget[] = [];
  if (action.kind === "click" || action.kind === "point" || action.kind === "type" || action.kind === "select") targets.push(action.target);
  if (action.kind === "scroll" && action.target) targets.push(action.target);
  for (const t of targets) {
    if ("point" in t && t.frameRevision < currentRevision) {
      throw err("stale-frame", `target was located on frame ${t.frameRevision}, current is ${currentRevision}`);
    }
  }
}
