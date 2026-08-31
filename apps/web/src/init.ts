// Bootstrapping + user actions: REST load, WS wiring, session lifecycle.
import { api } from "@polyth/session/web-api";
import { SyncClient, type SyncStatus } from "./sync.ts";
import { applyRemoteClientSettings, initSettingsSync } from "./settingsSync.ts";
import { displaySessionTitle, isPlaceholderTitle, modelToMarkdown } from "./format.ts";
import { friendlyError } from "./settings.ts";
import { formatAppUrl, parseAppUrl } from "./router.ts";
import * as store from "./store.ts";
import { resolveActiveProjectId } from "./projectRegistry.ts";
import type { AttachmentRef, JsonObject, ModelRef, Project, ProjectPatch, SessionEvent } from "@polyth/contracts";
import { suggestWorktreeBranch } from "./worktreeSessions.ts";
import { installPushDeepLinks, registerServiceWorker } from "./push.ts";
import { notificationCentre } from "./notificationCentre.ts";
import { applyComposerSeed } from "./drafts.ts";
import { forkSeedKey, rewindSeedKey } from "./messageActions.ts";
import {
  getSessionDefaults,
  projectRemembersModelSelection,
  resolveProjectModelDefault,
} from "./sessionDefaults.ts";
import { initPluginBridge } from "./pluginBridge.ts";
import { reconcilePackage } from "./packages/reconcile.ts";
import { tr } from "./i18n/index.ts";
import { desktopBridge } from "./desktopBridge.ts";
import { clearSendFailure, reportSendFailure } from "./sendFailure.ts";
import { markSessionPerformance } from "./sessionPerformance.ts";

let sync: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";
const syncStatusListeners = new Set<() => void>();
let lastSubSession: string | undefined;
let lastProject: string | null | undefined;
let branchFetchedFor: string | null = null;
let runtimeCatalogHydrated = false;
let runtimeCatalogPolicy: "browser" | "pending" | "project" | "interaction" = "browser";
let openSessionGeneration = 0;
const hydratedSessions = new Set<string>();

function hydrateRuntimeCatalog(): void {
  if (runtimeCatalogHydrated) return;
  runtimeCatalogHydrated = true;
  void refreshModels();
  void refreshAgents();
}

function deferRuntimeCatalogUntilInteraction(): void {
  const hydrate = () => {
    if (!store.getState().activeProjectId) return;
    window.removeEventListener("pointerdown", hydrate, true);
    window.removeEventListener("keydown", hydrate, true);
    window.removeEventListener("polyth:hydrate-runtime-catalog", hydrate);
    hydrateRuntimeCatalog();
  };
  window.addEventListener("pointerdown", hydrate, true);
  window.addEventListener("keydown", hydrate, true);
  window.addEventListener("polyth:hydrate-runtime-catalog", hydrate);
}

// Branch is resolved per (project, worktree): a session attached to a git
// worktree reports that worktree's branch, never the primary checkout's
// (UX-FIXTURE-VISUAL P0 — header/status must derive from the resolved root).
// Sessions WITHOUT a worktree share the project's primary checkout, so
// switching among them — or to the new-chat surface — reuses the fetched
// branch instead of refetching git status on every session change (P0 perf:
// spawning a session issues zero extra git requests).
const branchScope = (sessionId: string | null): string => {
  if (!sessionId) return "";
  const session = store.getState().sessions.find((candidate) => candidate.id === sessionId);
  return session?.worktreePath ?? "";
};
const branchKey = (projectId: string, scope: string): string =>
  `${projectId}\0${scope}`;

export function getSyncStatus(): SyncStatus {
  return syncStatus;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  syncStatusListeners.add(listener);
  return () => syncStatusListeners.delete(listener);
}

export function reconnectSync(): void {
  sync?.reconnect();
}

function publishSyncStatus(status: SyncStatus): void {
  if (status === syncStatus) return;
  syncStatus = status;
  for (const listener of [...syncStatusListeners]) listener();
}

function fetchBranch(projectId: string, sessionId: string | null): void {
  const key = branchKey(projectId, branchScope(sessionId));
  branchFetchedFor = key;
  // A late response only publishes when the same (project, worktree) scope is
  // still active — a newer scope's fetch owns the branch label by then.
  const stillCurrent = (): boolean => {
    const current = store.getState();
    return branchFetchedFor === key
      && current.activeProjectId === projectId
      && branchKey(projectId, branchScope(current.activeSessionId)) === key;
  };
  void api.gitStatus(projectId, sessionId ?? undefined)
    .then((st) => {
      if (stillCurrent()) store.setGitBranch(st.branch ?? "");
    })
    .catch(() => {
      if (stillCurrent()) store.setGitBranch("");
    });
}

// ---- session URLs -----------------------------------------------------------
// The address bar always reflects the active project/session so links can be
// shared and agents can deep-link (/p/:projectId/s/:sessionId or ?session=).
let urlSyncStarted = false;
interface PolythHistoryState {
  polyth: true;
  depth: number;
}

const historyDepth = (): number => {
  const value = history.state as Partial<PolythHistoryState> | null;
  return value?.polyth === true && typeof value.depth === "number" ? Math.max(0, value.depth) : 0;
};

/** Align the address bar with the store. Boot uses replaceState (no junk
 *  history entry); user-driven switches push so Back works. Skips when the
 *  URL already matches — popstate navigation never double-pushes. */
function syncUrl(replace: boolean): void {
  const s = store.getState();
  const target = formatAppUrl(s.activeProjectId, s.activeSessionId);
  if (location.pathname === target && !location.search.includes("session=")) return;
  if (replace) history.replaceState({ polyth: true, depth: historyDepth() } satisfies PolythHistoryState, "", target);
  else history.pushState({ polyth: true, depth: historyDepth() + 1 } satisfies PolythHistoryState, "", target);
  if (s.activeSessionId) markSessionPerformance("route_committed", s.activeSessionId);
}

/** Navigate only within Polyth. At a deep-linked session with no in-app
 * history, fall back to its project hero instead of leaving the WebView. */
export function navigateBackInApp(): boolean {
  if (historyDepth() > 0) {
    history.back();
    return true;
  }
  const current = store.getState();
  if (current.activeView !== "session") {
    store.setActiveView("session");
    return true;
  }
  if (current.activeSessionId && current.activeProjectId) {
    const target = formatAppUrl(current.activeProjectId, null);
    history.replaceState({ polyth: true, depth: 0 } satisfies PolythHistoryState, "", target);
    store.activateSession(null);
    return true;
  }
  return false;
}

/** Apply a validated native deep link through the same popstate route used by
 * browser history. The native shell parses schemes; this layer owns app state. */
export function openNativeAppPath(path: string): void {
  if (!path.startsWith("/")) return;
  history.pushState({ polyth: true, depth: historyDepth() + 1 } satisfies PolythHistoryState, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

function startUrlSync(): void {
  if (urlSyncStarted) return;
  urlSyncStarted = true;
  syncUrl(true); // canonicalize whatever the boot URL was
  let lastUrlProject = store.getState().activeProjectId;
  let lastUrlSession = store.getState().activeSessionId;
  store.subscribeStore(() => {
    const s = store.getState();
    if (s.activeProjectId === lastUrlProject && s.activeSessionId === lastUrlSession) return;
    lastUrlProject = s.activeProjectId;
    lastUrlSession = s.activeSessionId;
    syncUrl(false);
  });
  window.addEventListener("popstate", () => {
    const loc = parseAppUrl(location.pathname, location.search);
    const s = store.getState();
    if (loc.sessionId && loc.sessionId !== s.activeSessionId) {
      void openSession(loc.sessionId).catch(() => {});
    } else if (!loc.sessionId) {
      if (loc.projectId && loc.projectId !== s.activeProjectId) store.activateProject(loc.projectId);
      else if (!loc.projectId && s.activeSessionId) store.activateSession(null);
    }
  });
}

export function init(): void {
  // PWA installability is independent from the opt-in push subscription.
  // Auth has already succeeded before init(), so register without prompting.
  void registerServiceWorker().catch((err) => console.warn("service worker registration failed", err));
  // UX-ONBOARDING boot: project, model, and agent hydration launch
  // independently and publish as soon as each settles. Awaiting a combined
  // Promise.all/allSettled before publishing any result is forbidden — a slow
  // or failed catalog request can never delay, erase, or roll back projects.
  void refreshProjects("initial");
  const desktop = desktopBridge();
  if (desktop) {
    runtimeCatalogPolicy = "pending";
    void desktop.getSettings()
      .then((settings) => {
        runtimeCatalogPolicy = settings.lowResourceMode ? "interaction" : "project";
        if (settings.lowResourceMode) {
          deferRuntimeCatalogUntilInteraction();
        } else if (store.getState().activeProjectId) {
          hydrateRuntimeCatalog();
        }
      })
      .catch(() => {
        runtimeCatalogPolicy = "project";
        if (store.getState().activeProjectId) hydrateRuntimeCatalog();
      });
  } else {
    hydrateRuntimeCatalog();
  }
  startSync();
  // Shared client preferences: pull the server copy, then mirror local edits
  // and apply changes made on other devices.
  initSettingsSync();
  // F18: notification clicks from the service worker land here when a tab
  // already exists (postMessage instead of a second window).
  installPushDeepLinks(openSession);
  store.subscribeStore(() => {
    const s = store.getState();
    if (s.activeSessionId !== lastSubSession) {
      lastSubSession = s.activeSessionId ?? undefined;
      // projectId scopes the server's projection snapshot; the server skips
      // it entirely when this socket already holds the same scope.
      if (sync) {
        sync.setSubscription(
          s.activeSessionId ?? undefined,
          s.activeSessionId ? store.lastSeq(s.activeSessionId) : 0,
          s.activeProjectId ?? undefined,
        );
      }
    }
    if (s.activeProjectId !== lastProject) {
      lastProject = s.activeProjectId;
      if (s.activeProjectId) {
        if (runtimeCatalogPolicy === "project") hydrateRuntimeCatalog();
        void refreshSessions(s.activeProjectId);
        fetchBranch(s.activeProjectId, s.activeSessionId);
      } else {
        branchFetchedFor = null;
        store.setGitBranch("");
      }
    } else if (
      s.activeProjectId
      && branchFetchedFor !== branchKey(s.activeProjectId, branchScope(s.activeSessionId))
    ) {
      // Worktree scope changed (or an earlier fetch failed) — refetch once per
      // (project, worktree) pair (UX-04, UX-FIXTURE-VISUAL). Switches between
      // sessions of the same checkout reuse the label without a request.
      fetchBranch(s.activeProjectId, s.activeSessionId);
    }
  });
}

// ---- project registry hydration (UX-ONBOARDING) ------------------------------

export type ProjectRefreshReason = "initial" | "manual" | "reconcile";

let bootRestored = false;
let reconcileRetryTimer: ReturnType<typeof setTimeout> | undefined;

/** Generation-safe project refresh: increment the request id and capture the
 *  mutationVersion (store ticket), publish only when the response is still
 *  current, and reconcile once when a mutation superseded the captured data.
 *  Initial failure publishes `failed`; a refresh failure keeps the ready
 *  snapshot and exposes a retryable, non-blocking refresh error. */
export async function refreshProjects(reason: ProjectRefreshReason = "manual"): Promise<void> {
  const ticket = store.beginProjectListRequest();
  try {
    const projects = await api.listProjects();
    const outcome = store.publishProjectList(ticket, projects);
    if (outcome === "superseded-by-mutation") {
      void refreshProjects("reconcile");
      return;
    }
    if (outcome !== "published") return;
    await restoreSelectionAfterReady();
  } catch (err) {
    console.error("project list failed", err);
    const hadSnapshot = store.getState().projectRegistry.status === "ready";
    store.failProjectList(ticket, friendlyError(tr("common.error"), err));
    if (hadSnapshot) {
      // Non-blocking refresh warning; known data stays usable.
      store.setUiError(friendlyError(tr("common.error"), err));
      if (reason === "reconcile" && reconcileRetryTimer === undefined) {
        reconcileRetryTimer = setTimeout(() => {
          reconcileRetryTimer = undefined;
          void refreshProjects("reconcile");
        }, 4_000);
      }
    }
  }
}

/** URL/session restoration begins once projects are ready — never delayed by
 *  model/agent catalogs. Selection order: valid session deep link, valid
 *  project deep link, valid saved id, then the first server project. An
 *  invalid link reports a recoverable error and falls through; it never
 *  manufactures an empty first run. */
async function restoreSelectionAfterReady(): Promise<void> {
  const registry = store.getState().projectRegistry;
  if (registry.status !== "ready") return;
  const projects = registry.projects;

  if (!bootRestored) {
    bootRestored = true;
    const fromUrl = parseAppUrl(location.pathname, location.search);
    const initial = resolveActiveProjectId(projects, {
      urlProjectId: fromUrl.projectId ?? null,
      savedProjectId: localStorage.getItem("polyth.activeProjectId"),
    });
    if (initial) store.activateProject(initial);
    if (fromUrl.sessionId) {
      // A valid session deep link resolves its owning project and wins.
      // Boot restoration must not close the restored workspace pane.
      try {
        await openSession(fromUrl.sessionId, { showChat: false });
      } catch (err) {
        console.warn("session from URL not found, falling back", err);
        store.setUiError(tr("init.sessionLinkCouldNotOpen"));
      }
    } else if (initial) {
      const savedSession = localStorage.getItem("polyth.activeSessionId");
      if (savedSession) {
        await refreshSessions(initial);
        if (store.getState().sessions.some((session) => session.id === savedSession)) {
          await openSession(savedSession, { showChat: false }).catch(() => {});
        }
      }
    }
    startUrlSync();
    return;
  }

  // Later refresh: keep the current active project when it still exists,
  // otherwise resolve a replacement (or none when the registry emptied).
  const active = store.getState().activeProjectId;
  if (active && !projects.some((p) => p.id === active)) {
    store.activateProject(projects[0]?.id ?? null);
  } else if (!active && projects.length > 0) {
    store.activateProject(projects[0]!.id);
  }
}

// An empty model catalog blocks the composer ("No models available" +
// disabled send), and a backend that is still starting — or restarting under
// the page — legitimately answers empty/with an error for a while. Latching
// that first answer bricked session creation until a manual reload (QA P0).
// Retry with capped backoff until a non-empty catalog lands; a WS (re)connect
// also re-checks immediately, so recovery follows the backend, not a timer.
const MODEL_RETRY_BASE_MS = 2_000;
const MODEL_RETRY_MAX_MS = 30_000;
const MODEL_REQUEST_TIMEOUT_MS = 8_000;
let modelRetryTimer: ReturnType<typeof setTimeout> | undefined;
let modelRetryDelay = MODEL_RETRY_BASE_MS;
let modelFetchAbort: AbortController | undefined;
let modelRetryRequested = false;

function scheduleModelRetry(): void {
  if (modelRetryTimer !== undefined) return;
  modelRetryTimer = setTimeout(() => {
    modelRetryTimer = undefined;
    void refreshModels();
    void refreshAgents();
  }, modelRetryDelay);
  modelRetryDelay = Math.min(modelRetryDelay * 2, MODEL_RETRY_MAX_MS);
}

/** Backend churn healed: an empty published catalog re-checks right away. */
export function recheckRuntimeCatalog(): void {
  if (!runtimeCatalogHydrated) return;
  if (store.getState().models.length > 0) return;
  if (modelRetryTimer !== undefined) {
    clearTimeout(modelRetryTimer);
    modelRetryTimer = undefined;
  }
  modelRetryDelay = MODEL_RETRY_BASE_MS;
  // A runtime that died during startup can leave its HTTP request pending. Do
  // not make recovery wait for the browser's much longer fetch timeout.
  if (modelsFetchInFlight) {
    modelRetryRequested = true;
    modelFetchAbort?.abort();
    return;
  }
  void refreshModels();
  void refreshAgents();
}

let modelsFetchInFlight = false;

async function refreshModels(): Promise<void> {
  if (modelsFetchInFlight) return;
  modelsFetchInFlight = true;
  const controller = new AbortController();
  modelFetchAbort = controller;
  const timeout = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
  try {
    const models = await api.listModels(controller.signal);
    store.setModels(models);
    if (models.length > 0) {
      if (modelRetryTimer !== undefined) clearTimeout(modelRetryTimer);
      modelRetryTimer = undefined;
      modelRetryDelay = MODEL_RETRY_BASE_MS;
      return;
    }
    scheduleModelRetry();
  } catch (err) {
    // Project onboarding continues; the composer catalog owns its own state.
    if (!controller.signal.aborted) console.error("list models failed", err);
    scheduleModelRetry();
  } finally {
    clearTimeout(timeout);
    if (modelFetchAbort === controller) modelFetchAbort = undefined;
    modelsFetchInFlight = false;
    if (modelRetryRequested) {
      modelRetryRequested = false;
      void refreshModels();
      void refreshAgents();
    }
  }
}

async function refreshAgents(): Promise<void> {
  try {
    store.setAgents(await api.listAgents());
  } catch (err) {
    console.error("list agents failed", err);
  }
}

function startSync(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  sync = new SyncClient();
  sync.onStatus(publishSyncStatus);
  // Frame-batched ingestion: streaming and gap-fill bursts fold into at most
  // one store update per paint. The timeout keeps hidden/background windows
  // ingesting when requestAnimationFrame is paused.
  let pending: SessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushFrame: number | null = null;
  const flush = (): void => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    if (flushFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(flushFrame);
    flushTimer = null;
    flushFrame = null;
    const batch = pending;
    pending = [];
    if (batch.length > 0) store.applyEvents(batch);
  };
  const scheduleFlush = (): void => {
    if (flushTimer !== null || flushFrame !== null) return;
    flushTimer = setTimeout(flush, 32);
    if (typeof requestAnimationFrame === "function") flushFrame = requestAnimationFrame(flush);
  };
  sync.onEvent((msg) => {
    if (msg.type === "event") {
      pending.push(msg.event);
      scheduleFlush();
    } else if (msg.type === "events") {
      // Batched gap-fill frame: the whole chunk joins one store update.
      pending.push(...msg.events);
      scheduleFlush();
    } else if (msg.type === "projection") {
      store.upsertSession(msg.session);
    } else if (msg.type === "projections") {
      store.upsertSessions(msg.sessions);
    } else if (msg.type === "notification/added") {
      // NTF-01: global inbox rows bypass the session event batch entirely —
      // they are derived state, never part of any session's log or reducer.
      notificationCentre.append(msg.notification);
    } else if (msg.type === "package/changed") {
      reconcilePackage(msg.package);
    } else if (msg.type === "client-settings/changed") {
      // A settings change from another device — apply it live (theme, density,
      // interface scale, …). Echoes of this device's own change are dropped by
      // revision inside settingsSync.
      applyRemoteClientSettings(msg.settings);
    }
  });
  // Gap-fill on every successful (re)connect; merge-by-id makes the race with
  // the initial bootstrap fetch safe. No polling.
  sync.onOpen(() => {
    void notificationCentre.catchUp();
    // Re-pull shared settings: a broadcast may have been missed while the
    // socket was down.
    initSettingsSync();
    // A reconnect after backend churn is the moment an empty model catalog
    // becomes fetchable again — heal it now instead of waiting out a backoff.
    recheckRuntimeCatalog();
  });
  void initPluginBridge(sync).catch((error) => {
    console.error("plugin bridge initialization failed", error);
  });
  sync.connect(`${proto}://${location.host}/ws`);
  void notificationCentre.bootstrap();
}

// ---- session / project actions --------------------------------------------

// ---- paginated hydration (P0 perf) ------------------------------------------
// A first open fetches only the NEWEST window and renders immediately; older
// history backfills in the background (and further on scroll-up), so a
// 300k-event session paints as fast as a fresh one. `deriveMessages`/rewind
// stay correct: active rewind markers are recent by construction (they sit at
// the log tail), and the auto-backfill below extends the window past the
// rewind TARGET so undone-range marking is complete.
const INITIAL_EVENT_WINDOW = 40;
const BACKFILL_CHUNK = 2000;
/** Background backfill stops here; scroll-up keeps loading beyond on demand. */
const AUTO_BACKFILL_TARGET = 4000;
const backfillInFlight = new Set<string>();
const tailRequests = new Map<string, { passive: boolean; promise: Promise<SessionEvent[]> }>();
const prefetchedSessions = new Set<string>();

function requestSessionTail(sessionId: string, passive: boolean): Promise<SessionEvent[]> {
  const existing = tailRequests.get(sessionId);
  if (existing) return existing.promise;
  markSessionPerformance("request_started", sessionId);
  const request = api.getEvents(sessionId, 0, { limit: INITIAL_EVENT_WINDOW, prefetch: passive })
    .then((events) => {
      markSessionPerformance("response_received", sessionId);
      const active = store.getState().activeSessionId;
      if (active) store.touchSessionCache(active);
      store.touchSessionCache(sessionId);
      store.applyEvents(events);
      store.ensureEventCache(sessionId);
      hydratedSessions.add(sessionId);
      markSessionPerformance("messages_ingested", sessionId);
      return events;
    })
    .finally(() => {
      if (tailRequests.get(sessionId)?.promise === request) tailRequests.delete(sessionId);
    });
  tailRequests.set(sessionId, { passive, promise: request });
  return request;
}

/** Pointer intent warms only the canonical SQLite tail. It never activates,
 *  routes, reports an error, or touches the runtime/import path. */
export function prefetchSessionTail(sessionId: string): void {
  const s = store.getState();
  if (hydratedSessions.has(sessionId) && s.events[sessionId] !== undefined) return;
  prefetchedSessions.add(sessionId);
  void requestSessionTail(sessionId, true).catch(() => {
    prefetchedSessions.delete(sessionId); // a later pointer intent may retry
  });
}

async function reconcileSession(sessionId: string, afterSeq: number, generation: number): Promise<void> {
  const cachedBase = store.getState().events[sessionId] ?? [];
  const projectionAtRequest = store.getState().sessions.find((session) => session.id === sessionId);
  markSessionPerformance("request_started", sessionId);
  const [session, events] = await Promise.all([
    api.getSession(sessionId),
    // This suffix stays unbounded: a limit could skip middle events when a
    // prefetched/cached tail fell behind before activation.
    api.getEvents(sessionId, afterSeq, { prefetch: false }),
  ]);
  markSessionPerformance("response_received", sessionId);
  if (generation !== openSessionGeneration) return;
  const active = store.getState().activeSessionId;
  if (active) store.touchSessionCache(active);
  store.touchSessionCache(sessionId);
  const currentProjection = store.getState().sessions.find((candidate) => candidate.id === sessionId);
  if (currentProjection === undefined || currentProjection === projectionAtRequest) {
    store.upsertSession(session);
  }
  // The LRU may have evicted this session while REST was in flight. Restore
  // the immutable cached base before its unbounded suffix so no gap appears.
  store.applyEvents(cachedBase);
  store.applyEvents(events);
  store.ensureEventCache(sessionId);
  hydratedSessions.add(sessionId);
  prefetchedSessions.delete(sessionId);
  markSessionPerformance("messages_ingested", sessionId);
}

/** Fetch one chunk of history older than the cached window. Returns true when
 *  events were added, false at log start / while another fetch is in flight. */
export async function loadOlderEvents(sessionId: string, chunk = BACKFILL_CHUNK): Promise<boolean> {
  if (backfillInFlight.has(sessionId)) return false;
  const oldest = store.oldestSeq(sessionId);
  if (oldest <= 1) return false; // nothing cached yet, or already at seq 1
  backfillInFlight.add(sessionId);
  try {
    const older = await api.getEvents(sessionId, 0, { beforeSeq: oldest, limit: chunk });
    if (older.length === 0) return false;
    store.applyEvents(older);
    return true;
  } finally {
    backfillInFlight.delete(sessionId);
  }
}

/** True while more history should stream in without user interaction. */
function wantsAutoBackfill(sessionId: string): boolean {
  if (store.hasFullHistory(sessionId)) return false;
  const events = store.getState().events[sessionId];
  if (!events || events.length === 0) return false;
  if (events.length < AUTO_BACKFILL_TARGET) return true;
  // Rewind correctness: the undone range spans [atSeq, marker]; when the
  // marker is loaded but its target is older than the window, keep going.
  const model = store.reduceSessionModel(sessionId, events);
  return model.rewind !== null && model.rewind.atSeq < events[0]!.seq;
}

function scheduleAutoBackfill(sessionId: string, generation: number): void {
  const step = async (): Promise<void> => {
    if (generation !== openSessionGeneration) return; // another open took over
    if (store.getState().activeSessionId !== sessionId) return;
    if (!wantsAutoBackfill(sessionId)) return;
    const added = await loadOlderEvents(sessionId).catch(() => false);
    if (!added) return;
    setTimeout(() => void step(), 50); // yield between chunks; UI stays fluid
  };
  setTimeout(() => void step(), 200); // let the fresh window paint first
}

export async function openSession(
  sessionId: string,
  opts: {
    /** UX-FILES-TIMELINE-03 finding 8: user-driven switches (default) always
     *  land in the session's chat view — the open workspace pane closes and
     *  the primary view returns to "session". Boot restoration passes false
     *  so a reload keeps the restored pane. */
    showChat?: boolean;
  } = {},
): Promise<void> {
  const generation = ++openSessionGeneration;
  const before = store.getState();
  const cachedSession = before.sessions.find((session) => session.id === sessionId);
  // The events entry can be LRU-evicted while the id stays in hydratedSessions;
  // an evicted session re-hydrates exactly like a first open.
  const cachedEvents = before.events[sessionId];
  const useCachedView = hydratedSessions.has(sessionId) && cachedSession !== undefined && cachedEvents !== undefined;
  const afterSeq = useCachedView ? store.lastSeq(sessionId) : 0;

  // Revisited sessions render their canonical cached history immediately while
  // metadata and the append-only suffix revalidate. A first open remains in
  // the loading state so an incomplete WS fragment can never masquerade as the
  // full log.
  if (useCachedView) {
    if (cachedSession.projectId !== before.activeProjectId) store.activateProject(cachedSession.projectId);
    store.activateSession(sessionId);
    if (opts.showChat !== false) store.showSessionChat();
    // Claim takeover: this open owns navigation now. A superseded first
    // open's loading claim must not survive it — a leaked claim renders every
    // hero-eligible surface (fresh spawn included) as an endless loading row.
    store.setOpeningSession(null);
  } else {
    store.setOpeningSession(sessionId);
  }
  // Navigation baseline, captured after the synchronous cached-path
  // transition: when the user moves elsewhere while this fetch is in flight
  // (new-chat intent, project switch, another session), the resolved open
  // still lands its data in the cache but never steals the surface back.
  // The intent compares by identity — an open STARTED from the new-chat
  // surface still activates; only an intent created during the flight blocks.
  const baseline = store.getState();
  const userNavigatedAway = (): boolean => {
    const now = store.getState();
    return now.newSessionIntent !== baseline.newSessionIntent
      || now.activeProjectId !== baseline.activeProjectId
      || now.activeSessionId !== baseline.activeSessionId;
  };
  try {
    if (useCachedView) {
      await reconcileSession(sessionId, afterSeq, generation);
      if (generation === openSessionGeneration) {
        maybeSeedFromReplay(sessionId);
        scheduleAutoBackfill(sessionId, generation);
      }
      return;
    }
    // Metadata and history are independent reads. Starting both together saves
    // one full round trip on high-latency links and old-session deep links.
    // First opens fetch only the newest window; older history backfills below.
    const tailWasPrefetched = prefetchedSessions.has(sessionId)
      || tailRequests.get(sessionId)?.passive === true;
    const [session] = await Promise.all([
      cachedSession ?? api.getSession(sessionId),
      requestSessionTail(sessionId, false),
    ]);
    if (generation !== openSessionGeneration) return;
    store.upsertSession(session);
    store.ensureEventCache(sessionId); // empty logs still count as cached
    hydratedSessions.add(sessionId);
    maybeSeedFromReplay(sessionId);
    if (!userNavigatedAway()) {
      if (session.projectId !== store.getState().activeProjectId) store.activateProject(session.projectId);
      store.activateSession(sessionId);
      if (opts.showChat !== false) store.showSessionChat();
      scheduleAutoBackfill(sessionId, generation);
    }
    if (tailWasPrefetched) await reconcileSession(sessionId, store.lastSeq(sessionId), generation);
  } finally {
    // A newer concurrent open owns the claim and active-session transition.
    if (
      generation === openSessionGeneration
      && store.getState().openingSessionId === sessionId
    ) {
      store.setOpeningSession(null);
    }
  }
}

/** Replay-derived composer seeding (UX-MSG-ACTIONS): an active rewind marker
 *  or an unconsumed fork lineage marker seeds the draft at most once. Direct
 *  URL reload therefore restores the same editable draft; edited or cleared
 *  drafts are never overwritten (provenance in drafts.ts). */
function maybeSeedFromReplay(sessionId: string): void {
  const events = store.getState().events[sessionId] ?? [];
  if (events.length === 0) return;
  // Prime/reuse the shared incremental reducer cache. Timeline's first render
  // now receives this model instead of replaying a large history a second time.
  const model = store.reduceSessionModel(sessionId, events);
  if (model.rewind?.draft) {
    applyComposerSeed(sessionId, rewindSeedKey(model.rewind.markerSeq), model.rewind.draft);
  } else if (model.fork?.draft && !model.fork.seedConsumed) {
    applyComposerSeed(sessionId, forkSeedKey(model.fork.fromSessionId, model.fork.sourceAtSeq), model.fork.draft);
  }
}

export async function refreshSessions(projectId: string): Promise<void> {
  try {
    store.setSessions(projectId, await api.listSessions(projectId));
  } catch (err) {
    console.error("list sessions failed", err);
  }
}

// Add/Create ordering (UX-ONBOARDING): the POST response is authoritative for
// id, name, and canonical path. On success the store applies one atomic
// upsert-and-activate transition (mutationVersion increments, so any list
// captured before the mutation is discarded), then a non-blocking
// reconciliation list request starts. No session is created and no remote Git
// endpoint is contacted here; local branch enrichment follows activation.
export async function addProject(path: string, name?: string): Promise<Project> {
  const p = await api.addProject(path, name);
  store.applyProjectAdded(p);
  void refreshProjects("reconcile");
  return p;
}

export async function createProject(path: string, name?: string): Promise<Project> {
  const p = await api.createProject(path, name);
  store.applyProjectAdded(p);
  void refreshProjects("reconcile");
  return p;
}

/** SSH-remote project: same atomic upsert-and-activate transition as
 *  addProject — the POST response is authoritative and already carries the
 *  remote binding validated on the server. */
export async function addSshProject(input: {
  connectionId: string;
  path: string;
  name?: string;
  createDirectory?: boolean;
}): Promise<Project> {
  const p = await api.sshCreateProject(input);
  store.applyProjectAdded(p);
  void refreshProjects("reconcile");
  return p;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const updated = await api.patchProject(id, { name });
  store.applyProjectUpsert(updated);
}

/** Persist presentation metadata in the project registry, rather than as a
 * browser-only sidebar preference. */
export async function updateProjectAppearance(
  id: string,
  patch: ProjectPatch,
): Promise<void> {
  const updated = await api.patchProject(id, patch);
  store.applyProjectUpsert(updated);
}

/** Save a composer choice only for projects that opted into model memory. */
export async function rememberProjectModelSelection(id: string, model: ModelRef): Promise<void> {
  const project = store.getState().projectRegistry.projects.find((candidate) => candidate.id === id);
  if (!projectRemembersModelSelection(project?.defaults)) return;
  const updated = await api.patchProject(id, {
    defaults: { rememberModelSelection: true, model },
  });
  store.applyProjectUpsert(updated);
}

export async function removeProject(id: string): Promise<void> {
  await api.deleteProject(id);
  store.applyProjectRemoved(id);
  void refreshProjects("reconcile");
}

export interface CreateSessionOptions {
  title?: string;
  model?: ModelRef;
  agent?: string;
  worktreePath?: string;
  /** Start loading the chat without waiting for its initial replay. */
  precache?: boolean;
}

async function createDefaultWorktree(projectId: string, title?: string): Promise<string> {
  const [worktrees, branches] = await Promise.all([
    api.listWorktrees(projectId),
    api.gitBranches(projectId),
  ]);
  const taken = [
    ...worktrees.map((worktree) => worktree.branch).filter((branch): branch is string => !!branch),
    ...branches.branches.map((branch) => branch.name),
  ];
  const branch = suggestWorktreeBranch(
    store.getState().settings.branchTemplate,
    title || "session",
    taken,
  );
  return (await api.createWorktree(projectId, branch)).path;
}

export async function createSession(projectId: string, opts: CreateSessionOptions = {}): Promise<string> {
  const { precache = false, ...input } = opts;
  const project = store.getState().projectRegistry.projects.find((candidate) => candidate.id === projectId);
  const defaults = getSessionDefaults();
  const model = opts.model ?? resolveProjectModelDefault(
    project?.defaults,
    defaults.defaultModel,
  );
  const agent = opts.agent ?? project?.defaults?.agent ?? defaults.defaultAgent;
  const worktreePath = opts.worktreePath
    ?? (project?.defaults?.worktreeBehavior === "fresh-worktree"
      ? await createDefaultWorktree(projectId, opts.title)
      : undefined);
  const { id: sessionId } = await api.createSession({
    projectId,
    ...input,
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  });
  // Instant spawn (UX): the id is authoritative and the session is seconds
  // old, so publish an optimistic projection + empty canonical event window
  // and open the chat NOW. openSession() then revalidates through its cached
  // path in the background (metadata + any suffix), and refreshSessions
  // reconciles the projection — zero blocking round trips after the POST.
  const now = Date.now();
  store.seedSessionCache({
    id: sessionId,
    projectId,
    title: input.title ?? "",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  });
  hydratedSessions.add(sessionId);
  if (projectId !== store.getState().activeProjectId) store.activateProject(projectId);
  store.activateSession(sessionId);
  store.showSessionChat();
  const opening = openSession(sessionId);
  if (precache) {
    void opening.catch((error) => {
      console.error("precache session failed", error);
      store.setUiError(friendlyError(tr("common.error"), error));
    });
  } else {
    await opening;
  }
  void refreshSessions(projectId);
  return sessionId;
}

export async function forkSession(sessionId: string, atSeq?: number): Promise<void> {
  const result = await api.fork(sessionId, atSeq);
  // Per-message fork: persist the excluded prompt as the child's editable
  // draft BEFORE navigation, so the child composer mounts already seeded and
  // a reload replays the same state (marker-owned, applied at most once).
  if (result.draft) {
    applyComposerSeed(
      result.id,
      forkSeedKey(result.fromSessionId ?? sessionId, result.sourceAtSeq),
      result.draft,
    );
  }
  const proj = store.getState().sessions.find((s) => s.id === sessionId)?.projectId;
  await openSession(result.id);
  if (proj) void refreshSessions(proj);
}

export async function archiveSession(sessionId: string): Promise<void> {
  await api.archive(sessionId);
  const proj = store.getState().sessions.find((s) => s.id === sessionId)?.projectId;
  if (proj) void refreshSessions(proj);
}

export async function restoreSession(sessionId: string): Promise<void> {
  await api.restore(sessionId);
  const proj = store.getState().sessions.find((s) => s.id === sessionId)?.projectId;
  if (proj) void refreshSessions(proj);
}

/** Hard delete through the guarded server path. Callers confirm destructive
 *  intent for running/pending sessions BEFORE calling this. */
export async function deleteSession(sessionId: string): Promise<void> {
  const proj = store.getState().sessions.find((s) => s.id === sessionId)?.projectId;
  await api.deleteSession(sessionId);
  if (store.getState().activeSessionId === sessionId) store.activateSession(null);
  if (proj) void refreshSessions(proj);
}

export interface SendOptions {
  /** Captured at click time — project/session switches must never reroute a send. */
  targetSessionId?: string | null;
  delivery?: "normal" | "steer" | "queue" | "interrupt";
  /** Atomically reject open questions / deny open permissions before admission. */
  dismissPending?: boolean;
  /** Reusable execution configuration resolved server-side (WP8). A string
   *  selects a profile, `null` explicitly clears the session's stored one,
   *  omitted inherits it (UX-COMPOSER-DISC). */
  agentProfileId?: string | null;
  /** Composer pills (F2); validated + persisted server-side before the model sees them. */
  attachments?: AttachmentRef[];
}

/** Returns true when the server accepted the message (callers that persist
 *  pending composer configuration consume it only on success). */
export async function sendMessage(text: string, model?: JsonObject, agent?: string, opts?: SendOptions): Promise<boolean> {
  const id = opts?.targetSessionId ?? store.getState().activeSessionId;
  if (!id) return false;
  // The server records an auto title with the first admitted user message.
  // Keeping this durable prevents later projection broadcasts, refreshes, and
  // reconnects from restoring the "New session" placeholder.
  const session = store.getState().sessions.find((s) => s.id === id);
  const autoTitle = store.getState().settings.autoTitleSessions
    && !!session
    && isPlaceholderTitle(session.title, session.id);
  try {
    await api.sendMessage(id, {
      text, model, agent, ...(autoTitle ? { autoTitle: true } : {}),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts?.delivery ? { delivery: opts.delivery } : {}),
      ...(opts?.dismissPending ? { dismissPending: true } : {}),
      // Explicit null must reach the wire (it clears the stored profile);
      // only an omitted field means "inherit".
      ...(opts?.agentProfileId !== undefined ? { agentProfileId: opts.agentProfileId } : {}),
    });
    clearSendFailure(id);
    return true;
  } catch (err) {
    console.error("send message failed", err);
    reportSendFailure(id, err);
    store.setUiError(friendlyError(tr("common.error"), err));
    return false;
  }
}

export async function abortSession(): Promise<void> {
  const id = store.getState().activeSessionId;
  if (!id) return;
  try {
    await api.abort(id);
  } catch (err) {
    console.error("abort failed", err);
    store.setUiError(friendlyError(tr("composer.stopTheCurrentResponse"), err));
  }
}

/** Rate-limit wait: stop the scheduled auto-resume; the turn stays failed. */
export async function cancelResume(sessionId: string): Promise<void> {
  try {
    await api.cancelResume(sessionId);
  } catch (err) {
    console.error("cancel resume failed", err);
    store.setUiError(friendlyError(tr("common.error"), err));
  }
}

/** Rate-limit wait: resend the last message now, optionally on another model. */
export async function resumeNow(sessionId: string, model?: JsonObject): Promise<void> {
  try {
    await api.resumeNow(sessionId, model as ModelRef | undefined);
  } catch (err) {
    console.error("resume now failed", err);
    store.setUiError(friendlyError(tr("common.error"), err));
  }
}

export function replyPermission(requestId: string, reply: "once" | "always" | "reject", scope?: "session" | "project"): void {
  const id = store.getState().activeSessionId;
  if (!id) return;
  void api.replyPermission(id, requestId, reply, scope).catch((err) => console.error("permission reply failed", err));
}

export function answerQuestion(requestId: string, answers: JsonObject): void {
  const id = store.getState().activeSessionId;
  if (!id) return;
  void api.answerQuestion(id, requestId, answers).catch((err) => console.error("question reply failed", err));
}

export function rejectQuestion(requestId: string): void {
  const id = store.getState().activeSessionId;
  if (!id) return;
  void api.rejectQuestion(id, requestId).catch((err) => console.error("question reject failed", err));
}

export async function replySecret(requestId: string, action: "save" | "dismiss", value?: string): Promise<void> {
  const id = store.getState().activeSessionId;
  if (!id) return;
  try {
    await api.replySecret(id, requestId, action, value);
  } catch (err) {
    console.error("secret reply failed", err);
    store.setUiError(friendlyError(tr("common.error"), err));
    throw err;
  }
}

export function exportSessionMarkdown(): void {
  const s = store.getState();
  if (!s.activeSessionId) return;
  const model = store.reduceSessionModel(s.activeSessionId, s.events[s.activeSessionId] ?? []);
  const stored = s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? "";
  const firstUser = model.messages.find((m) => m.kind === "user");
  const title = displaySessionTitle(stored, s.activeSessionId, firstUser?.kind === "user" ? firstUser.text : undefined);
  const blob = new Blob([modelToMarkdown(model)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
