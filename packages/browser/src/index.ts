// Controlled browser service (WP14): one isolated context per browser session
// shared by the user and the agent, revisioned frames with newest-only
// delivery, URL policy on every hop, redacted observations, honest
// capability reporting when no engine is available.
import { randomUUID } from "node:crypto";
import type {
  BrowserAction,
  BrowserColorScheme,
  BrowserContext,
  BrowserContextCaptureInput,
  BrowserObservation,
  BrowserSessionDto,
  BrowserTarget,
  Disposable,
  JsonObject,
  JsonValue,
} from "@polyth/contracts";
import type { BrowserArtifactStore } from "./artifacts.ts";
import { captureBrowserContext } from "./context.ts";
import type { BrowserDriver, DriverFrame, DriverPage, DriverPageEvent } from "./driver.ts";
import { checkUrl, originOf, type UrlPolicyOptions } from "./policy.ts";
import { redactObservationText, redactUrl } from "./redact.ts";
import {
  createScreencastPacing,
  markScreencastFrameEmitted,
  noteScreencastActivity,
  shouldEmitScreencastFrame,
} from "./screencastPacing.ts";

export type { BrowserDriver, DriverFrame, DriverPage, DriverPageEvent, DriverObservation, DriverNav, DriverOpenOptions } from "./driver.ts";
export { createFakeDriver, demoWeb, type FakeWeb, type FakePage } from "./fake.ts";
export {
  checkUrl,
  checkTopLevelNavigation,
  checkNetworkEgress,
  isInternalBrowserUrl,
  isLoopbackHost,
  isPrivateAddress,
  isLoopbackAddress,
  originAliases,
  originOf,
  type UrlDecision,
  type UrlPolicyOptions,
  type UrlCheckPurpose,
  type PrivateNetworkPolicy,
  type Resolver,
} from "./policy.ts";
export { redactObservationText, redactUrl, type RedactOptions } from "./redact.ts";
export { createChromiumDriver, findChromiumExecutable, CHROMIUM_CANDIDATE_PATHS } from "./chromium.ts";
export { createBrowserArtifactStore, type BrowserArtifactStore, BROWSER_ARTIFACT_TTL_MS, BROWSER_ARTIFACT_MAX_FILES } from "./artifacts.ts";
export { captureBrowserContext } from "./context.ts";
export type {
  ProfileContext,
  ProfileDriver,
  ProfileDriverOpenOptions,
  ProfilePage,
  ProfilePageEvent,
  ProfileNav,
  ScreencastFrame,
  NavigationKind,
} from "./profileDriver.ts";
export { MANUAL_ONLY_POLICY } from "./profileDriver.ts";
export { createFakeProfileDriver, resetFakeProfileLocks } from "./fakeProfile.ts";
export {
  createProfileChromiumDriver,
  profileChromiumAvailable,
  resetProfileChromiumLocks,
  isTopLevelNavigationRequest,
  classifyTopLevelRequest,
  webSocketUrlAsHttp,
} from "./profileChromium.ts";
export type { TopLevelRequestClass, TopLevelOwnerLookup } from "./profileChromium.ts";
export {
  createProfileRegistry,
  newChatTabId,
  type ProfileRegistry,
  type ProfileFrame,
  type ProfileRegistryEvent,
  type TabRecord,
  type ProfileOpenInput,
} from "./profileRegistry.ts";
export {
  createScreencastPacing,
  noteScreencastActivity,
  setScreencastVisible,
  screencastMinIntervalMs,
  shouldEmitScreencastFrame,
  markScreencastFrameEmitted,
} from "./screencastPacing.ts";

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
  /** Optional page-pixel target emitted for a short-lived agent focus cue. */
  targetRect?: { x: number; y: number; width: number; height: number };
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
  actor?: "user" | "agent";
}

export interface BrowserObserveOptions {
  includeScreenshot?: boolean;
  selector?: string;
  actor?: "user" | "agent";
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
  /** Server-owned destinations that must match exactly (no apex/www alias). */
  exactAllowedOrigins?: () => string[];
  resolve?: UrlPolicyOptions["resolve"];
  secrets?: ReadonlyArray<string>;
  maxSessions?: number;
  maxLifetimeMs?: number;
  maxConsoleEntries?: number;
  maxObservationChars?: number;
  actionTimeoutMs?: number;
  /** Persist model-visible browser lifecycle facts in the canonical session. */
  append?: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  /** Controlled Browser defaults to denying private-network destinations unless listed. */
  privateNetwork?: UrlPolicyOptions["privateNetwork"];
  /** Production controlled browser may permit public HTTP(S) after gateway authorization. */
  allowPublicOrigins?: boolean;
}

export interface BrowserService {
  capability(): BrowserCapability;
  create(input: BrowserCreateInput): Promise<BrowserSessionDto>;
  get(id: string): BrowserSessionDto | null;
  list(): BrowserSessionDto[];
  navigate(id: string, url: string, actor: "user" | "agent"): Promise<BrowserSessionDto>;
  action(id: string, action: BrowserAction, actor: "user" | "agent"): Promise<{ actionId: string; session: BrowserSessionDto; result?: JsonObject }>;
  observe(id: string, opts?: BrowserObserveOptions): Promise<ObservationWithShot>;
  captureContext(id: string, input: BrowserContextCaptureInput, artifacts: BrowserArtifactStore): Promise<BrowserContext>;
  close(id: string): Promise<void>;
  closeAll(): Promise<void>;
  pauseAgent(id: string, paused: boolean): void;
  agentPaused(id: string): boolean;
  approveOrigin(origin: string, browserSessionId?: string): void;
  approvals(browserSessionId?: string): string[];
  console(id: string): Array<{ at: number; level: string; message: string }>;
  latestFrame(id: string, afterRevision?: number): BrowserFrame | null;
  onFrame(cb: (frame: BrowserFrame) => void): Disposable;
  onEvent(cb: (event: BrowserRuntimeEvent) => void): Disposable;
  /** Tell the service whether at least one visible viewer is subscribed. */
  setViewerVisible(id: string, visible: boolean): void;
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
  disposeDriverFrames: () => void;
  pacing: ReturnType<typeof createScreencastPacing>;
  viewerVisible: boolean;
  screencastActive: boolean;
  screencastStarting: Promise<void> | null;
  pauseGeneration: number;
  pendingOperations: Set<Promise<void>>;
}

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const SETTLED_PROMISE = Symbol("browser-operation-settled");
type TimeoutAwarePromise<T> = Promise<T> & { [SETTLED_PROMISE]?: Promise<void> };

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

/** Keep durable browser facts useful without putting query strings, form
 * values, or credentials into the canonical session log. */
const durableUrl = (raw: string): string => {
  return redactUrl(raw);
};

const durableMessage = (raw: string): string => redactObservationText(raw, { maxChars: 500 });

const durableTarget = (target: BrowserTarget): string => {
  if ("selector" in target) return `selector ${durableMessage(target.selector)}`;
  if ("text" in target) return `text target${target.exact ? " (exact)" : ""}`;
  if ("role" in target) return `role ${durableMessage(target.role)}${target.name ? " (named)" : ""}`;
  return `point ${Math.round(target.point.x)},${Math.round(target.point.y)} @${target.frameRevision}`;
};

const durableActionSummary = (action: BrowserAction): string => {
  switch (action.kind) {
    case "click": return `click ${durableTarget(action.target)}`;
    case "point": return `point ${durableTarget(action.target)}`;
    case "type": return `type ${durableTarget(action.target)}`;
    case "press": return `press ${durableMessage(action.key)}`;
    case "scroll": return `scroll ${action.x ?? 0},${action.y ?? 0}${action.target ? ` ${durableTarget(action.target)}` : ""}`;
    case "select": return `select ${durableTarget(action.target)}`;
    case "wait": return `wait ${action.condition}`;
    case "back": return "back";
    case "forward": return "forward";
    case "reload": return "reload";
    case "resize": return `resize ${action.viewport.width}x${action.viewport.height}`;
    case "color-scheme": return `color-scheme ${action.colorScheme}`;
    case "inspect": return `inspect ${durableMessage(action.selector)}`;
  }
};

const targetForHighlight = (action: BrowserAction): BrowserTarget | null => {
  if (action.kind === "click" || action.kind === "type") return action.target;
  return null;
};

export function createBrowserService(opts: BrowserServiceOptions): BrowserService {
  const driver = opts.driver;
  const maxSessions = opts.maxSessions ?? 4;
  const maxLifetimeMs = opts.maxLifetimeMs ?? 30 * 60_000;
  const maxConsole = opts.maxConsoleEntries ?? 200;
  const actionTimeoutMs = opts.actionTimeoutMs ?? 20_000;
  const sessions = new Map<string, SessionState>();
  // The no-session set is retained as a compatibility path for trusted local
  // callers; remote approval routes should always pass the browser session id.
  const approved = new Set<string>();
  const approvedBySession = new Map<string, Set<string>>();
  const frameCbs = new Set<(f: BrowserFrame) => void>();
  const eventCbs = new Set<(e: BrowserRuntimeEvent) => void>();

  const policyOpts = (browserSessionId?: string): UrlPolicyOptions => ({
    allowedOrigins: opts.allowedOrigins?.() ?? [],
    exactAllowedOrigins: opts.exactAllowedOrigins?.() ?? [],
    approvedOrigins: new Set([
      ...approved,
      ...(browserSessionId ? approvedBySession.get(browserSessionId) ?? [] : []),
    ]),
    privateNetwork: opts.privateNetwork ?? "explicit-only",
    purpose: opts.allowPublicOrigins ? "subresource" : "top-level",
    ...(opts.resolve ? { resolve: opts.resolve } : {}),
  });

  const emit = (e: BrowserRuntimeEvent) => { for (const cb of [...eventCbs]) cb(e); };

  const appendFor = async (sessionId: string | undefined, type: string, data: JsonObject): Promise<void> => {
    if (sessionId && opts.append) await opts.append(sessionId, type, data);
  };

  const appendFailure = async (
    sessionId: string | undefined,
    browserSessionId: string,
    actor: "user" | "agent",
    failure: unknown,
    actionKind?: BrowserAction["kind"],
  ): Promise<void> => {
    const error = failure as Error & { code?: string };
    await appendFor(sessionId, "browser/action-failed", {
      browserSessionId,
      actor,
      code: error.code ?? "internal",
      // Locator fill/select failures may echo submitted values verbatim,
      // including short values that credential-pattern redaction cannot know.
      message: actionKind === "type" || actionKind === "select"
        ? `browser ${actionKind} failed`
        : durableMessage(error.message ?? String(failure)),
    });
  };

  const stateOf = (id: string): SessionState => {
    const s = sessions.get(id);
    if (!s || s.dto.status === "closed") throw err("not-found", `no browser session ${id}`);
    if (s.dto.status === "failed") throw err("failed", `browser session ${id} failed`);
    return s;
  };

  const captureFrame = async (s: SessionState): Promise<void> => {
    try {
      const shot = await s.page.screenshot();
      publishFrame(s, shot);
    } catch {
      // screenshot failure is non-fatal; revision only moves with a frame
    }
  };

  const publishFrame = (s: SessionState, frame: DriverFrame | { data: Uint8Array; mime: string }): void => {
    s.dto.revision += 1;
    s.frame = { browserSessionId: s.dto.id, revision: s.dto.revision, mime: frame.mime, data: frame.data };
    for (const cb of [...frameCbs]) cb(s.frame);
  };

  const wantsScreencast = (s: SessionState): boolean =>
    s.viewerVisible && frameCbs.size > 0 && Boolean(s.page.startScreencast && s.page.stopScreencast);

  const syncScreencast = (s: SessionState): void => {
    if (wantsScreencast(s)) {
      if (s.screencastActive || s.screencastStarting || !s.page.startScreencast) return;
      const starting = s.page.startScreencast({ quality: 60, maxWidth: 1280, maxHeight: 800 });
      s.screencastStarting = starting;
      void starting.then(() => {
        if (s.screencastStarting !== starting) return;
        s.screencastStarting = null;
        if (wantsScreencast(s)) s.screencastActive = true;
        else if (s.page.stopScreencast) void s.page.stopScreencast().catch(() => {});
      }).catch((error) => {
        if (s.screencastStarting === starting) s.screencastStarting = null;
        emit({ browserSessionId: s.dto.id, kind: "screencast-failed", message: durableMessage(String((error as Error).message ?? error)) });
      });
      return;
    }
    if (!s.screencastActive) return;
    s.screencastActive = false;
    if (s.page.stopScreencast) void s.page.stopScreencast().catch(() => {});
  };

  const syncNav = (s: SessionState): void => {
    const cur = s.page.current();
    s.dto.url = cur.url;
    s.dto.title = cur.title;
  };

  /** Serialize user+agent work on one session; a shared queue is what makes
   *  "user and agent operate the same context" safe. Agent work re-checks
   *  pause immediately before execution so Take control is authoritative. */
  const enqueue = <T>(s: SessionState, work: () => Promise<T>, actor?: "user" | "agent", expectedPauseGeneration?: number): Promise<T> => {
    let operationSettled: Promise<void> | undefined;
    const gated = async (): Promise<T> => {
      if (actor === "agent" && (s.agentPaused || expectedPauseGeneration !== s.pauseGeneration)) {
        throw err("agent-paused", "agent control is paused for this browser session");
      }
      const before = new Set(s.pendingOperations);
      const started = work() as TimeoutAwarePromise<T>;
      operationSettled = started[SETTLED_PROMISE]
        ?? Promise.all([...s.pendingOperations].filter((operation) => !before.has(operation))).then(() => undefined);
      return started;
    };
    const run = s.queue.then(gated, gated);
    // A timeout races the caller's promise, but the underlying Playwright
    // operation may still be mutating the page. Keep the session queue held
    // until that operation settles so the next mutation cannot overlap it.
    s.queue = run.then(() => operationSettled, () => operationSettled)
      .then(() => undefined, () => undefined);
    return run;
  };

  const withController = async <T>(
    s: SessionState,
    actor: "user" | "agent",
    fn: () => Promise<T>,
    extra?: { actionId?: string; actionKind?: string },
  ): Promise<T> => {
    if (extra?.actionKind) {
      emit({
        browserSessionId: s.dto.id,
        kind: "action",
        actor,
        actionId: extra.actionId,
        message: extra.actionKind,
      });
    }
    s.dto.controller = actor;
    emit({ browserSessionId: s.dto.id, kind: "controller", actor, actionId: extra?.actionId });
    try {
      return await fn();
    } finally {
      delete s.dto.controller;
      emit({ browserSessionId: s.dto.id, kind: "controller", actionId: extra?.actionId });
    }
  };

  const withTimeout = <T>(s: SessionState, p: Promise<T>, ms: number, what: string): TimeoutAwarePromise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = p.then(() => undefined, () => undefined);
    s.pendingOperations.add(settled);
    void settled.then(() => { s.pendingOperations.delete(settled); });
    const raced = Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(err("timeout", `${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
    const out = raced.then(
      (value) => { if (timer) clearTimeout(timer); return value; },
      (failure) => { if (timer) clearTimeout(timer); throw failure; },
    ) as TimeoutAwarePromise<T>;
    Object.defineProperty(out, SETTLED_PROMISE, { value: settled });
    return out;
  };

  const doClose = async (id: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    approvedBySession.delete(id);
    clearTimeout(s.lifetimeTimer);
    s.disposeDriverEvents();
    s.disposeDriverFrames();
    s.viewerVisible = false;
    s.screencastActive = false;
    if (s.page.stopScreencast) await s.page.stopScreencast().catch(() => {});
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
      const actor = input.actor ?? "user";
      await appendFor(input.sessionId, "browser/action-requested", {
        browserSessionId: id,
        actor,
        actionSummary: `create browser for project ${durableMessage(input.projectId)}`,
      });
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
        agentPaused: false,
        // Agent-created contexts are background-controlled and must not be
        // resized by a responsive Preview observer when they become visible.
        viewportMode: actor === "agent" ? "custom" : "responsive",
      };
      let page: DriverPage;
      try {
        page = await driver.open({
        ...viewport,
        colorScheme: dto.colorScheme,
        guardNavigation: async (url) => {
          let decision = await checkUrl(url, policyOpts(id));
          if (!decision.ok && decision.code === "approval-required") {
            // In-page hops to public origins auto-follow (approval recorded);
            // private destinations remain explicit-only even for in-page hops.
            const o = originOf(url);
            if (o) {
              const sessionApproved = approvedBySession.get(id) ?? new Set<string>();
              sessionApproved.add(o);
              approvedBySession.set(id, sessionApproved);
              decision = await checkUrl(url, policyOpts(id));
            }
          }
          if (!decision.ok) {
            emit({ browserSessionId: id, kind: "navigation-blocked", url: redactUrl(url), message: decision.reason });
            throw err(decision.code, decision.reason);
          }
        },
        guardNetworkEgress: async (url) => {
          const decision = await checkUrl(url, { ...policyOpts(id), purpose: "subresource" });
          if (!decision.ok) {
            emit({ browserSessionId: id, kind: "network-blocked", url: redactUrl(url), message: decision.reason });
            throw err(decision.code, decision.reason);
          }
        },
        });
      } catch (failure) {
        await appendFailure(input.sessionId, id, actor, failure);
        throw failure;
      }
      const s: SessionState = {
        dto,
        page,
        queue: Promise.resolve(),
        agentPaused: false,
        consoleBuf: [],
        frame: null,
        lifetimeTimer: setTimeout(() => void doClose(id), maxLifetimeMs),
        disposeDriverEvents: () => {},
        disposeDriverFrames: () => {},
        pacing: createScreencastPacing(),
        viewerVisible: false,
        screencastActive: false,
        screencastStarting: null,
        pauseGeneration: 0,
        pendingOperations: new Set(),
      };
      s.lifetimeTimer.unref?.();
      s.disposeDriverEvents = page.onEvent((ev: DriverPageEvent) => {
        if (ev.kind === "crash") {
          s.dto.status = "failed";
          s.frame = null;
          s.viewerVisible = false;
          syncScreencast(s);
        }
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
          ...(ev.url !== undefined ? { url: redactUrl(ev.url) } : {}),
          ...(ev.level !== undefined ? { level: ev.level } : {}),
        });
      });
      if (page.onFrame) {
        s.disposeDriverFrames = page.onFrame((frame) => {
          if (!s.viewerVisible || !shouldEmitScreencastFrame(s.pacing)) return;
          markScreencastFrameEmitted(s.pacing);
          publishFrame(s, frame);
        });
      }
      sessions.set(id, s);
      dto.status = "ready";
      if (input.url) {
        try {
          await service.navigate(id, input.url, actor);
        } catch (error) {
          const failure = error as Error & { code?: string };
          if (failure.code !== "approval-required") throw error;
          // Session created but the initial URL needs approval — return the
          // session so the client can show its approval dialog.
          await enqueue(s, () => captureFrame(s));
          await appendFor(input.sessionId, "browser/action-completed", {
            browserSessionId: id,
            actor,
            url: durableUrl(s.dto.url),
            title: durableMessage(s.dto.title),
          });
          return { ...s.dto };
        }
      } else {
        await enqueue(s, () => captureFrame(s));
      }
      await appendFor(input.sessionId, "browser/action-completed", {
        browserSessionId: id,
        actor,
        url: durableUrl(s.dto.url),
        title: durableMessage(s.dto.title),
      });
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
      const expectedPauseGeneration = actor === "agent" ? s.pauseGeneration : undefined;
      await appendFor(s.dto.sessionId, "browser/action-requested", {
        browserSessionId: id,
        actor,
        actionSummary: `navigate ${durableUrl(url)}`,
      });
      // Fail fast with the policy code; the driver route guard still covers
      // every subsequent hop (redirects, in-page navigations).
      const decision = await checkUrl(url, policyOpts(id));
      if (!decision.ok) {
        emit({ browserSessionId: id, kind: "navigation-blocked", url: redactUrl(url), message: decision.reason });
        const failure = err(decision.code, decision.reason);
        await appendFailure(s.dto.sessionId, id, actor, failure);
        throw failure;
      }
      let result: BrowserSessionDto;
      try {
        result = await enqueue(s, async () => withController(s, actor, async () => {
          noteScreencastActivity(s.pacing);
          await withTimeout(s, s.page.goto(decision.url), actionTimeoutMs, "navigate");
          syncNav(s);
          await captureFrame(s);
          return { ...s.dto };
        }, { actionKind: "navigate" }), actor, expectedPauseGeneration);
      } catch (failure) {
        await appendFailure(s.dto.sessionId, id, actor, failure);
        throw failure;
      }
      await appendFor(s.dto.sessionId, "browser/action-completed", {
        browserSessionId: id,
        actor,
        url: durableUrl(result.url),
        title: durableMessage(result.title),
      });
      return result;
    },

    async action(id, action, actor) {
      const s = stateOf(id);
      if (actor === "agent" && s.agentPaused) throw err("agent-paused", "agent control is paused for this browser session");
      const actionId = randomUUID();
      const expectedPauseGeneration = actor === "agent" ? s.pauseGeneration : undefined;
      await appendFor(s.dto.sessionId, "browser/action-requested", {
        browserSessionId: id,
        actor,
        actionId,
        actionSummary: durableActionSummary(action),
      });
      try {
        validateTargets(action, s.dto.revision);
      } catch (failure) {
        await appendFailure(s.dto.sessionId, id, actor, failure, action.kind);
        throw failure;
      }
      let result: { actionId: string; session: BrowserSessionDto; result?: JsonObject };
      try {
        result = await enqueue(s, async () => withController(s, actor, async () => {
          noteScreencastActivity(s.pacing);
          const highlightTarget = actor === "agent" ? targetForHighlight(action) : null;
          if (highlightTarget && s.page.targetRect) {
            const targetRect = await withTimeout(
              s,
              s.page.targetRect(highlightTarget),
              actionTimeoutMs,
              "target geometry",
            );
            if (targetRect) {
              emit({
                browserSessionId: id,
                kind: "action",
                actor,
                actionId,
                message: action.kind,
                targetRect: {
                  x: Math.round(targetRect.x),
                  y: Math.round(targetRect.y),
                  width: Math.max(1, Math.round(targetRect.width)),
                  height: Math.max(1, Math.round(targetRect.height)),
                },
              });
            }
            // Target resolution is awaited work. Re-check the authoritative
            // takeover state before allowing the actual click/type to run.
            if (s.agentPaused || expectedPauseGeneration !== s.pauseGeneration) {
              throw err("agent-paused", "agent control is paused for this browser session");
            }
          }
        let result: JsonObject | undefined;
        const work = async (): Promise<void> => {
          switch (action.kind) {
            case "click": {
              const hit = await s.page.click(action.target);
              if (hit && Object.keys(hit).length) result = redactJsonObject(hit, opts.secrets ?? []);
              return;
            }
            case "point": {
              result = redactJsonObject(await s.page.point(action.target.point), opts.secrets ?? []);
              return;
            }
            case "type": return s.page.type(action.target, action.text, action.submit);
            case "press": {
              const hit = await s.page.press(action.key);
              if (hit && Object.keys(hit).length) result = redactJsonObject(hit, opts.secrets ?? []);
              return;
            }
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
              if (actor === "agent") {
                // Agent viewport choices remain fixed unless the action
                // explicitly asks for responsive behavior.
                s.dto.viewportMode = action.mode === "responsive" ? "responsive" : "custom";
              } else if (action.mode === "responsive" || action.mode === "preset" || action.mode === "custom") {
                s.dto.viewportMode = action.mode;
              }
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
        await withTimeout(s, work(), actionTimeoutMs, `action ${action.kind}`);
        syncNav(s);
        // Pointing is read-only. Keeping the revision stable means the returned
        // element geometry still describes the frame the user clicked.
        if (action.kind !== "point") await captureFrame(s);
        return { actionId, session: { ...s.dto }, ...(result ? { result } : {}) };
        }, { actionId, actionKind: action.kind }), actor, expectedPauseGeneration);
      } catch (failure) {
        await appendFailure(s.dto.sessionId, id, actor, failure, action.kind);
        throw failure;
      }
      await appendFor(s.dto.sessionId, "browser/action-completed", {
        browserSessionId: id,
        actionId,
        actor,
        url: durableUrl(result.session.url),
        title: durableMessage(result.session.title),
      });
      return result;
    },

    async observe(id, o = {}) {
      const s = stateOf(id);
      const actor = o.actor ?? "user";
      await appendFor(s.dto.sessionId, "browser/action-requested", {
        browserSessionId: id,
        actor,
        actionSummary: `observe${o.selector ? ` ${durableMessage(o.selector)}` : ""}`,
      });
      let out: ObservationWithShot;
      try {
        out = await enqueue(s, async () => {
        const raw = await withTimeout(s, s.page.observe(o.selector), actionTimeoutMs, "observe");
        const observed: ObservationWithShot = {
          url: raw.url,
          title: raw.title,
          text: redactObservationText(raw.text, { secrets: opts.secrets ?? [], maxChars: opts.maxObservationChars ?? 20_000 }),
          accessibilityDigest: redactObservationText(raw.accessibilityDigest, { secrets: opts.secrets ?? [], maxChars: 4_000 }),
        };
        if (o.includeScreenshot) {
          const shot = await s.page.screenshot();
          observed.screenshot = shot;
        }
        return observed;
        });
      } catch (failure) {
        await appendFailure(s.dto.sessionId, id, actor, failure);
        throw failure;
      }
      const observationMeta = {
        browserSessionId: id,
        actor,
        url: durableUrl(out.url),
        title: durableMessage(out.title),
        revision: s.dto.revision,
      } satisfies JsonObject;
      await appendFor(s.dto.sessionId, "browser/action-completed", observationMeta);
      await appendFor(s.dto.sessionId, "browser/observation", observationMeta);
      return out;
    },

    async captureContext(id, input, artifacts) {
      const s = stateOf(id);
      return enqueue(s, async () =>
        captureBrowserContext({
          input,
          session: s.dto,
          page: s.page,
          artifacts,
          secrets: opts.secrets ?? [],
        }));
    },

    close: doClose,

    async closeAll() {
      await Promise.all([...sessions.keys()].map(doClose));
      await driver?.close();
    },

    pauseAgent(id, paused) {
      const s = stateOf(id);
      if (paused && !s.agentPaused) s.pauseGeneration += 1;
      s.agentPaused = paused;
      s.dto.agentPaused = paused;
      emit({ browserSessionId: id, kind: paused ? "agent-paused" : "agent-resumed" });
    },

    agentPaused(id) {
      return stateOf(id).agentPaused;
    },

    approveOrigin(origin, browserSessionId) {
      const o = originOf(origin);
      if (!o) throw err("invalid-input", `not a valid origin: ${origin}`);
      if (browserSessionId) {
        stateOf(browserSessionId);
        const sessionApproved = approvedBySession.get(browserSessionId) ?? new Set<string>();
        sessionApproved.add(o);
        approvedBySession.set(browserSessionId, sessionApproved);
      } else {
        approved.add(o);
      }
    },

    approvals(browserSessionId) {
      return [...new Set([
        ...approved,
        ...(browserSessionId ? approvedBySession.get(browserSessionId) ?? [] : []),
      ])];
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
      for (const s of sessions.values()) syncScreencast(s);
      return { dispose: () => {
        frameCbs.delete(cb);
        if (frameCbs.size === 0) for (const s of sessions.values()) syncScreencast(s);
      } };
    },

    onEvent(cb) {
      eventCbs.add(cb);
      return { dispose: () => { eventCbs.delete(cb); } };
    },

    setViewerVisible(id, visible) {
      const s = sessions.get(id);
      if (!s || s.dto.status === "closed") return;
      if (s.dto.status === "failed") {
        s.viewerVisible = false;
        syncScreencast(s);
        return;
      }
      const wasVisible = s.viewerVisible;
      s.viewerVisible = visible;
      syncScreencast(s);
      // A viewer that becomes visible needs one current frame immediately.
      // The edge check matters because the WS layer periodically reasserts
      // visibility while checking authorization; repeated true calls must not
      // trigger screenshot work or restart the CDP screencast.
      if (visible && !wasVisible) void captureFrame(s);
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
