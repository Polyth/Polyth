// Bootstrapping + user actions: REST load, WS wiring, session lifecycle.
import { api, errorCodeOf } from "@polyth/session/web-api";
import { SyncClient, type SyncFreshness, type SyncStatus } from "./sync.ts";
import { sessionIdsToRefresh } from "./sessionStatus.ts";
import { applyRemoteClientSettings, initSettingsSync } from "./settingsSync.ts";
import { displaySessionTitle, isPlaceholderTitle, modelToMarkdown } from "./format.ts";
import { friendlyError } from "./settings.ts";
import { formatAppUrl, parseAppUrl, settingsPageFromSearch } from "./router.ts";
import * as store from "./store.ts";
import { resolveActiveProjectId, shouldRefreshProjectsOnSyncOpen } from "./projectRegistry.ts";
import { claimPersonalProjectAttempt } from "./personalProject.ts";
import { projectIsolationLevel } from "@polyth/contracts";
import { CONNECTION_RESTORED_EVENT, setConnectionGate } from "@polyth/contracts/transport-retry";
import type { AttachmentRef, HarnessSelection, JsonObject, ModelRef, Project, ProjectCloneInput, ProjectDefaults, ProjectPatch, ResumeTurnOptions, SessionDeleteOptions, SessionEvent, SessionProjection } from "@polyth/contracts";
import { suggestWorktreeBranch, temporaryWorktreeBranch } from "./worktreeSessions.ts";
import { installPushDeepLinks, reconcilePushSubscription, registerServiceWorker } from "./push.ts";
import { alertPersonMessage, installNotify } from "./notify.ts";
import { notificationCentre } from "./notificationCentre.ts";
import { applyComposerSeed, hydrateComposerDraft } from "./drafts.ts";
import { lastUserText, loadDraft, saveDraft, syncDraftToServer } from "./utils.ts";
import { requestComposerCompareReplace } from "./composerInsert.ts";
import { seedAttachments } from "./attachments.ts";
import { deadlineSignal } from "./deadline.ts";
import { forkSeedKey, rewindSeedKey } from "./messageActions.ts";
import {
  getSessionDefaults,
  projectRemembersModelSelection,
  resolveProjectModelDefault,
} from "./sessionDefaults.ts";
import { initPluginBridge } from "./pluginBridge.ts";
import { installExternalCapabilityDrag } from "./dnd.ts";
import { reconcilePackage } from "./packages/reconcile.ts";
import { tr } from "./i18n/index.ts";
import { desktopBridge } from "./desktopBridge.ts";
import { clearSendFailure, reportSendFailure } from "./sendFailure.ts";
import { markSessionPerformance } from "./sessionPerformance.ts";
import { shouldRefreshRuntimeFeatures } from "./runtimeFeaturesSync.ts";
import { flushClientPersistence, type PersistenceScope } from "./clientPersistence.ts";
import { hydrateLocalMutationIntent, loadLocalMutationIntent, reconcileLocalMutationIntent, submitDirectPrompt } from "./mutationIntent.ts";
import { createSessionWithRecovery } from "./sessionCreateRecovery.ts";
import { isNativeMobile, isPolythLinkLoopbackOrigin, returnToMobileConnectionHub } from "@polyth/mobile/runtime";
import { loadScopedDraftRecord, scopedDraftCacheKey, updateScopedDraftRecord, type ScopedDraftRecord } from "./draftRecord.ts";
import { clientPersistenceScope, persistenceScopeIsCurrent } from "./reliabilityContext.ts";
import { applyRemoteProjectPresentation, initProjectPresentationSync } from "./projectPresentationSync.ts";
import {
  peekPersistedRuntimeAgents,
  peekPersistedRuntimeModels,
  rememberPersistedRuntimeAgents,
  invalidateRuntimeCatalogs,
  rememberPersistedRuntimeModels,
  retryUnavailableRuntimeCatalogs,
  subscribeRuntimeCatalogInvalidations,
} from "@polyth/models/runtime-catalog";
import { createStaleCatalogTrigger, isStaleModelRefusal, signalsStaleModelCatalog } from "./modelCatalogStale.ts";
import { refreshProfiles } from "./profiles.ts";
import { isConfirmedStartupFailureEvent, isAgentMessageEvent, isEmptyFailedStartupSession, shouldDeleteFailedStartupSession } from "./failedStartupCleanup.ts";
import { createEventIngestionBatcher } from "./streamIngestion.ts";
import { holdLaunchReveal } from "./launchReveal.ts";
import { createSessionRuntimeWarm } from "./sessionRuntimeWarm.ts";

let sync: SyncClient | null = null;
const refreshStaleModelCatalog = createStaleCatalogTrigger(() => invalidateRuntimeCatalogs());
let syncStatus: SyncStatus = "disconnected";
const syncStatusListeners = new Set<() => void>();
let lastProject: string | null | undefined;
let branchFetchedFor: string | null = null;
let runtimeCatalogHydratedProjectId: string | null = null;
let runtimeCatalogInvalidationSubscribed = false;
/** One document-level listener for a capability dragged in from a window. */
let externalCapabilityDragInstalled = false;
let runtimeCatalogGeneration = 0;
let runtimeCatalogPolicy: "browser" | "pending" | "project" | "interaction" = "browser";
let nativeProxyProbe: Promise<void> | null = null;
let nativeProxyProbeFailures = 0;
let nativeProxyFirstFailureAt = 0;
let returningToConnectionHub = false;
let openSessionGeneration = 0;
const hydratedSessions = new Set<string>();
// Hints may be forgotten: the canonical cache/persisted log remains authoritative.
// Keep long-running clients from retaining every session ever visited.
function rememberSessionHint(hints: Set<string>, sessionId: string): void {
  hints.delete(sessionId);
  hints.add(sessionId);
  if (hints.size > 64) hints.delete(hints.values().next().value!);
}
const runtimeFeaturesInFlight = new Map<string, Promise<void>>();
const runtimeFeaturesDirty = new Set<string>();
const failedStartupCandidates = new Map<string, ReturnType<typeof setTimeout>>();
let failedStartupCleanupMonitorStarted = false;

function clearFailedStartupCandidate(sessionId: string): void {
  const timer = failedStartupCandidates.get(sessionId);
  if (timer !== undefined) clearTimeout(timer);
  failedStartupCandidates.delete(sessionId);
}

type DraftRecoverySnapshot = Pick<ScopedDraftRecord, "revision" | "text" | "attachments" | "nativeStaged">;

interface StartupCleanupFence {
  sessionId: string;
  projectId: string;
  sourceScope: PersistenceScope;
  sourceScopeKey: string;
  destinationScopeKey: string;
  destinationBaseline: DraftRecoverySnapshot;
}

function draftRecoverySnapshot(record: ScopedDraftRecord): DraftRecoverySnapshot {
  return {
    revision: record.revision,
    text: record.text,
    attachments: record.attachments,
    ...(record.nativeStaged ? { nativeStaged: record.nativeStaged } : {}),
  };
}

function sameDraftRecoverySnapshot(left: DraftRecoverySnapshot, right: DraftRecoverySnapshot): boolean {
  return left.revision === right.revision
    && left.text === right.text
    && JSON.stringify(left.attachments) === JSON.stringify(right.attachments)
    && JSON.stringify(left.nativeStaged ?? []) === JSON.stringify(right.nativeStaged ?? []);
}

function hasDraftRecoveryContent(record: DraftRecoverySnapshot): boolean {
  return record.text !== "" || record.attachments.length > 0 || (record.nativeStaged?.length ?? 0) > 0;
}

function startupCleanupNamespaceIsCurrent(fence: StartupCleanupFence | null, projectId: string): boolean {
  if (!fence || fence.projectId !== projectId) return false;
  return scopedDraftCacheKey(fence.sessionId) === fence.sourceScopeKey
    && scopedDraftCacheKey(null) === fence.destinationScopeKey;
}

function startupCleanupOwnerIsCurrent(fence: StartupCleanupFence | null, projectId: string): boolean {
  if (!startupCleanupNamespaceIsCurrent(fence, projectId)) return false;
  const current = store.getState();
  return current.activeSessionId === fence?.sessionId && current.activeProjectId === projectId;
}

/** Capture identity before any verification read yields. The cleanup may
 * finish after the user changes account/Space/connection or navigates, so the
 * later recovery must never derive a new namespace from that later context. */
function captureStartupCleanupFence(sessionId: string): StartupCleanupFence | null {
  const current = store.getState();
  const projectId = current.sessions.find((session) => session.id === sessionId)?.projectId
    ?? (current.activeSessionId === sessionId ? current.activeProjectId : null);
  if (!projectId) return null;
  const sourceScope = clientPersistenceScope({ projectId, sessionId });
  return {
    sessionId,
    projectId,
    sourceScope,
    sourceScopeKey: scopedDraftCacheKey(sessionId, sourceScope),
    destinationScopeKey: scopedDraftCacheKey(null),
    destinationBaseline: draftRecoverySnapshot(loadScopedDraftRecord(null)),
  };
}

interface StartupDraftRecovery extends StartupCleanupFence {
  pendingId?: string;
  fallbackText?: string;
  fallbackAttachments?: AttachmentRef[];
}

/** Capture the staged first prompt or sent user message before a verified failed
 * startup session is deleted, so the composer can recover the user's input. */
function captureStartupDraftRecovery(
  fence: StartupCleanupFence | null,
  projectId: string,
  events: readonly SessionEvent[],
): StartupDraftRecovery | null {
  if (!fence || fence.projectId !== projectId) return null;
  // The verified session may belong to a project that is no longer the active
  // reliability namespace by the time the API reads return.
  if (!startupCleanupOwnerIsCurrent(fence, projectId)) return null;
  const current = store.getState();
  // A pre-existing fresh-chat draft owns the destination; never replace it
  // with the failed startup prompt.
  if (hasDraftRecoveryContent(fence.destinationBaseline)) return null;
  const pending = current.pendingSends.findLast((item) => item.sessionId === fence.sessionId);
  const staged = loadScopedDraftRecord(fence.sessionId, fence.sourceScope);
  const stagedHasContent = hasDraftRecoveryContent(draftRecoverySnapshot(staged));

  let fallbackText: string | undefined;
  let fallbackAttachments: AttachmentRef[] | undefined;
  if (!stagedHasContent) {
    const userEvent = events.find((e) => e.type === "user/message");
    if (userEvent && userEvent.data && typeof userEvent.data === "object") {
      const d = userEvent.data as { raw?: unknown; text?: unknown; attachments?: unknown };
      const rawText = typeof d.raw === "string" ? d.raw : typeof d.text === "string" ? d.text : "";
      if (rawText) fallbackText = rawText;
      if (Array.isArray(d.attachments)) {
        const atts = d.attachments.filter((a): a is AttachmentRef =>
          typeof a === "object" && a !== null
          && typeof (a as { name?: unknown }).name === "string"
          && typeof (a as { mime?: unknown }).mime === "string");
        if (atts.length > 0) fallbackAttachments = atts;
      }
    } else if (pending) {
      if (pending.text) fallbackText = pending.text;
      if (pending.attachments && pending.attachments.length > 0) fallbackAttachments = pending.attachments;
    }
  }

  if (!stagedHasContent && !fallbackText && (!fallbackAttachments || fallbackAttachments.length === 0)) return null;
  return {
    ...fence,
    ...(pending ? { pendingId: pending.id } : {}),
    ...(fallbackText !== undefined ? { fallbackText } : {}),
    ...(fallbackAttachments !== undefined ? { fallbackAttachments } : {}),
  };
}

/** Move a captured first prompt to the unsaved-chat surface after deletion.
 * Do not steal focus from a different session or a fresh chat the user opened
 * while the guarded delete was in flight. */
async function restoreDeletedStartupDraft(recovery: StartupDraftRecovery): Promise<void> {
  const current = store.getState();
  if (current.activeSessionId !== null
    || current.activeProjectId !== recovery.projectId
    || current.newSessionIntent !== null) return;
  if (scopedDraftCacheKey(null) !== recovery.destinationScopeKey
    || scopedDraftCacheKey(recovery.sessionId) !== recovery.sourceScopeKey) return;
  const destination = draftRecoverySnapshot(loadScopedDraftRecord(null));
  if (!sameDraftRecoverySnapshot(destination, recovery.destinationBaseline)) return;
  // Delete is async and the composer may have committed another local edit
  // while it was pending. Read that session's authoritative scoped record only
  // after the guarded delete, never the bytes captured before the await.
  const source = loadScopedDraftRecord(recovery.sessionId, recovery.sourceScope);
  const sourceSnapshot = draftRecoverySnapshot(source);
  const sourceHasContent = hasDraftRecoveryContent(sourceSnapshot);
  if (!sourceHasContent && !recovery.fallbackText && (!recovery.fallbackAttachments || recovery.fallbackAttachments.length === 0)) return;

  const restoredText = sourceHasContent ? source.text : (recovery.fallbackText ?? "");
  const restoredAttachments = sourceHasContent ? source.attachments : (recovery.fallbackAttachments ?? []);
  const restoredNativeStaged = sourceHasContent ? (source.nativeStaged ?? []) : [];

  if (recovery.pendingId) store.endPendingSend(recovery.pendingId);
  store.startNewSession(recovery.projectId, { draft: restoredText });
  updateScopedDraftRecord(null, {
    attachments: restoredAttachments,
    nativeStaged: restoredNativeStaged,
    dirty: true,
    seed: undefined,
    conflict: undefined,
  });
  seedAttachments(null, restoredAttachments);
  // Native persistence can settle each scoped key independently. Keep the
  // deleted-session copy until the destination record is known durable; a
  // failed destination write must leave the source available for retry.
  await flushClientPersistence();
  updateScopedDraftRecord(recovery.sessionId, {
    text: "",
    attachments: [],
    nativeStaged: [],
    dirty: false,
    seed: undefined,
    conflict: undefined,
  }, recovery.sourceScope);
}

export function cleanupFailedStartupSession(sessionId: string, expectedFailureSeq?: number): Promise<void> {
  const fence = captureStartupCleanupFence(sessionId);
  clearFailedStartupCandidate(sessionId);
  return (async () => {
    // Let the existing send/Timeline error surface commit before the session
    // disappears from the active chat.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (!store.getState().settings.autoDeleteFailedStartupSessions) return;
    let projection: SessionProjection;
    let events: SessionEvent[];
    try {
      [projection, events] = await Promise.all([
        api.getSession(sessionId),
        // Verification must not wake or rebind a runtime that is about to be
        // removed; the prefetch read is canonical history only.
        api.getEvents(sessionId, 0, { prefetch: true }),
      ]);
    } catch (error) {
      // A failed read is not deletion proof. Keep the session and its error.
      console.error("failed startup cleanup could not verify session history", error);
      return;
    }
    if (projection.status !== "failed") return;
    const latest = events.at(-1);
    if (expectedFailureSeq !== undefined && latest?.seq !== expectedFailureSeq) return;
    const emptyStartupSession = isEmptyFailedStartupSession(events);
    if (!shouldDeleteFailedStartupSession(events) && !emptyStartupSession) return;
    if (!store.getState().settings.autoDeleteFailedStartupSessions) return;
    if (fence && !startupCleanupNamespaceIsCurrent(fence, projection.projectId)) return;
    const recovery = captureStartupDraftRecovery(fence, projection.projectId, events);
    try {
      await deleteSession(sessionId, { expectedLastEventSeq: latest?.seq ?? 0 });
      if (recovery) await restoreDeletedStartupDraft(recovery);
    } catch (error) {
      // The original startup error remains the useful user-facing failure;
      // deletion errors are non-fatal and leave the session available.
      console.error("failed startup session cleanup failed", error);
    }
  })();
}

/** Creation endpoints return the canonical id on a failed startup so the
 * client can show the existing error first, then verify and remove that exact
 * row. Unknown outcomes deliberately stay recoverable. */
export function cleanupFailedStartupSessionFromError(error: unknown): Promise<void> {
  if (!store.getState().settings.autoDeleteFailedStartupSessions || errorCodeOf(error) === "outcome-unknown") return Promise.resolve();
  const sessionId = typeof (error as { sessionId?: unknown })?.sessionId === "string"
    ? (error as { sessionId: string }).sessionId
    : undefined;
  return sessionId ? cleanupFailedStartupSession(sessionId) : Promise.resolve();
}

function cleanupFailedStartupCandidate(sessionId: string, expectedFailureSeq?: number): void {
  cleanupFailedStartupSession(sessionId, expectedFailureSeq);
}

function inspectFailedStartupCandidates(): void {
  const state = store.getState();
  if (!state.settings.autoDeleteFailedStartupSessions) {
    for (const sessionId of failedStartupCandidates.keys()) clearFailedStartupCandidate(sessionId);
    return;
  }
  for (const sessionId of failedStartupCandidates.keys()) {
    const events = state.events[sessionId];
    if (!events || events.length === 0) continue;
    if (events.some(isAgentMessageEvent)) {
      clearFailedStartupCandidate(sessionId);
      continue;
    }
    const latest = events.at(-1);
    if (latest && isConfirmedStartupFailureEvent(latest)) {
      cleanupFailedStartupCandidate(sessionId, latest.seq);
    } else if (latest?.type === "turn/stopped") {
      // A successful or user-aborted first turn is no longer a startup
      // candidate, even when it produced no assistant text.
      clearFailedStartupCandidate(sessionId);
    }
  }
}

function watchFailedStartupCandidates(): void {
  if (failedStartupCleanupMonitorStarted) return;
  failedStartupCleanupMonitorStarted = true;
  store.subscribeStore(inspectFailedStartupCandidates);
}

function trackFailedStartupCandidate(sessionId: string): void {
  watchFailedStartupCandidates();
  if (failedStartupCandidates.has(sessionId)) return;
  const timer = setTimeout(() => clearFailedStartupCandidate(sessionId), 30_000);
  // Do not keep Node-based tests alive for a browser-only expiry timer.
  (timer as unknown as { unref?: () => void }).unref?.();
  failedStartupCandidates.set(sessionId, timer);
}

async function loadRuntimeFeaturesForSession(sessionId: string): Promise<void> {
  const scope = scopedDraftCacheKey(sessionId);
  const existing = runtimeFeaturesInFlight.get(sessionId);
  if (existing) {
    runtimeFeaturesDirty.add(sessionId);
    return existing;
  }
  const run = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      runtimeFeaturesDirty.delete(sessionId);
      try {
        const features = await api.runtimeFeatures(sessionId);
        if (scope !== scopedDraftCacheKey(sessionId)) return;
        store.setRuntimeFeatures(sessionId, features);
      } catch {
        if (scope !== scopedDraftCacheKey(sessionId)) return;
        store.setRuntimeFeatures(sessionId, undefined);
      }
      if (!runtimeFeaturesDirty.has(sessionId)) break;
    }
  })();
  runtimeFeaturesInFlight.set(sessionId, run);
  try {
    await run;
  } finally {
    runtimeFeaturesInFlight.delete(sessionId);
    runtimeFeaturesDirty.delete(sessionId);
  }
}

const featureRefreshQueue = new Set<string>();
let featureRefreshActive = 0;
function queueFeatureRefresh(sessionId: string): void {
  if (featureRefreshQueue.size < 32) featureRefreshQueue.add(sessionId);
  const pump = () => {
    while (featureRefreshActive < 2 && featureRefreshQueue.size) {
      const id = featureRefreshQueue.values().next().value!;
      featureRefreshQueue.delete(id);
      const state = store.getState();
      if (id !== state.activeSessionId && !Object.prototype.hasOwnProperty.call(state.events, id)) continue;
      featureRefreshActive++;
      void loadRuntimeFeaturesForSession(id).finally(() => { featureRefreshActive--; pump(); });
    }
  };
  pump();
}

function pruneRuntimeFeatures(sessions: readonly { id: string }[]): void {
  const live = new Set(sessions.map((session) => session.id));
  store.pruneRuntimeFeatures(live);
}

export function handleProjectionBatch(incoming: readonly SessionProjection[]): void {
  const state = store.getState();
  const previous = new Map(state.sessions.map((session) => [session.id, session]));
  const refresh: string[] = [];
  for (const session of incoming) {
    const hasLoaded = session.id === state.activeSessionId || Object.prototype.hasOwnProperty.call(state.events, session.id);
    if (hasLoaded && shouldRefreshRuntimeFeatures(previous.get(session.id), session, true)) refresh.push(session.id);
  }
  store.upsertSessions(incoming);
  pruneRuntimeFeatures(store.getState().sessions);
  for (const id of refresh) queueFeatureRefresh(id);
}

function hydrateRuntimeCatalog(): void {
  const projectId = store.getState().activeProjectId;
  if (!projectId || runtimeCatalogHydratedProjectId === projectId) return;
  if (runtimeCatalogHydratedProjectId !== null && runtimeCatalogHydratedProjectId !== projectId) {
    modelsFetchInFlight?.controller.abort();
    modelsFetchInFlight = undefined;
    agentsFetchInFlight = undefined;
    if (modelRetryTimer !== undefined) clearTimeout(modelRetryTimer);
    modelRetryTimer = undefined;
    modelRetryDelay = MODEL_RETRY_BASE_MS;
  }
  runtimeCatalogHydratedProjectId = projectId;

  // A project switch must never paint the previous project's aggregate store.
  // Per-project persisted metadata is synchronous; only a genuinely cold
  // project starts the legacy aggregate request.
  const cachedModels = peekPersistedRuntimeModels(projectId);
  const cachedAgents = peekPersistedRuntimeAgents(projectId);
  if (cachedModels !== undefined) store.setModels(cachedModels);
  else {
    store.setModels([]);
    void refreshModels(projectId);
  }
  if (cachedAgents !== undefined) store.setAgents(cachedAgents);
  else {
    store.setAgents([]);
    void refreshAgents(projectId);
  }
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
// (header/status must derive from the resolved root).
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

let syncFreshness: SyncFreshness = { session: false, sessions: false };
const syncFreshnessListeners = new Set<() => void>();

/** What the server has confirmed current since the link last broke; see
 *  SyncFreshness. Stale data stays on screen — consumers only label it. */
export function getSyncFreshness(): SyncFreshness {
  return syncFreshness;
}

export function subscribeSyncFreshness(listener: () => void): () => void {
  syncFreshnessListeners.add(listener);
  return () => syncFreshnessListeners.delete(listener);
}

function publishSyncFreshness(next: SyncFreshness): void {
  syncFreshness = next;
  for (const listener of [...syncFreshnessListeners]) listener();
}

/** Longest a background refresh waits for the open session to catch up; the
 *  wait only orders work, it must never become the reason work is late. */
const PRIORITY_WAIT_MS = 3_000;

/** Run `work` once the open session is confirmed current (or after
 *  PRIORITY_WAIT_MS). On a phone the Link is one narrow pipe: background
 *  reads fired at reconnect would queue the screen's own catch-up behind them. */
function afterSessionCatchUp(work: () => void): void {
  if (syncFreshness.session) {
    work();
    return;
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    syncFreshnessListeners.delete(check);
    work();
  };
  const check = () => { if (syncFreshness.session) run(); };
  const timer = setTimeout(run, PRIORITY_WAIT_MS);
  syncFreshnessListeners.add(check);
}

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

/** Native/browser lifecycle hint. It suppresses retry work but never claims
 * authentication or reachability; the next socket handshake remains truth. */
export function setSyncForeground(isForeground: boolean): void {
  sync?.setRetryHints({ foreground: isForeground });
  if (!isForeground) void flushClientPersistence().catch(() => undefined);
}

/** How long a read retry waits for the socket to come back before it asks
 *  anyway; the socket shares the reads' transport (the Polyth Link on a phone). */
const LIVE_CONNECTION_WAIT_MS = 8_000;

function waitForLiveConnection(signal?: AbortSignal | null): Promise<void> {
  const reconnecting = () => syncStatus === "connecting" || syncStatus === "reconnecting";
  if (!sync || !reconnecting()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      syncStatusListeners.delete(check);
      signal?.removeEventListener("abort", onAbort);
    };
    const check = () => {
      if (reconnecting()) return;
      finish();
      resolve();
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason ?? Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, LIVE_CONNECTION_WAIT_MS);
    syncStatusListeners.add(check);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
setConnectionGate(waitForLiveConnection);

function publishSyncStatus(status: SyncStatus): void {
  if (status !== syncStatus) {
    syncStatus = status;
    for (const listener of [...syncStatusListeners]) listener();
  }
  if (status === "connected") {
    nativeProxyProbeFailures = 0;
    nativeProxyFirstFailureAt = 0;
  } else if (status === "reconnecting") {
    void verifyNativeLoopbackProxy();
  }
}

function verifyNativeLoopbackProxy(): Promise<void> {
  if (!isNativeMobile() || !isPolythLinkLoopbackOrigin(location.origin)
    || returningToConnectionHub) return Promise.resolve();
  if (nativeProxyProbe) return nativeProxyProbe;
  nativeProxyProbe = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch("/__polyth/client-context", {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`local proxy context: HTTP ${response.status}`);
      const value = await response.json() as { protocolVersion?: unknown; connectionScope?: unknown };
      if (value.protocolVersion !== 1 || typeof value.connectionScope !== "string" || !value.connectionScope) {
        throw new Error("local proxy context is invalid");
      }
      nativeProxyProbeFailures = 0;
      nativeProxyFirstFailureAt = 0;
    } catch {
      const now = Date.now();
      if (nativeProxyProbeFailures === 0) nativeProxyFirstFailureAt = now;
      nativeProxyProbeFailures += 1;
      // Give the native foreground controller time to restore a suspended
      // transport. Persistent local HTTP failure is distinct from a healthy
      // proxy whose remote /ws leg is temporarily unreachable.
      if (nativeProxyProbeFailures >= 2
        && now - nativeProxyFirstFailureAt >= 3_000
        && syncStatus === "reconnecting"
        && (typeof document === "undefined" || document.visibilityState !== "hidden")) {
        returningToConnectionHub = true;
        await flushClientPersistence().catch(() => undefined);
        await returnToMobileConnectionHub(
          `${location.pathname}${location.search}${location.hash}`,
          { resume: true },
        );
      }
    } finally {
      clearTimeout(timeout);
      nativeProxyProbe = null;
    }
  })();
  return nativeProxyProbe;
}

async function reconcileClientMutation(sessionId: string, hydrate = false): Promise<void> {
  const scopeKey = scopedDraftCacheKey(sessionId);
  const intent = hydrate ? await hydrateLocalMutationIntent(sessionId) : loadLocalMutationIntent(sessionId);
  const outcome = await reconcileLocalMutationIntent(sessionId);
  if (outcome === "unknown") {
    reportSendFailure(sessionId, Object.assign(new Error("mutation outcome remains unknown"), { code: "outcome-unknown" }), scopeKey);
  } else if (outcome === "applied" || outcome === "not-applied") {
    clearSendFailure(sessionId, scopeKey);
    // A reload or killed tab can leave the submitted prompt staged as a
    // recovery draft after admission. The turn owns those bytes now, so the
    // chat must not look like a Draft and the prompt must not return to the
    // composer. Only an exact match with the newest admitted prompt is retired.
    if (outcome === "applied" && intent?.kind === "turn-submit") retireConsumedDraft(sessionId);
  }
}

function retireConsumedDraft(sessionId: string): void {
  const draft = loadDraft(sessionId);
  if (!draft.trim()) return;
  const admitted = lastUserText(store.getState().events[sessionId]);
  if (!admitted || admitted.trim() !== draft.trim()) return;
  saveDraft(sessionId, "");
  syncDraftToServer(sessionId, "");
  requestComposerCompareReplace({ scopeKey: scopedDraftCacheKey(sessionId), expectedText: draft, text: "" });
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
  // The branch label is part of the first screen: a launch keeps its veil
  // until it is known (bounded by launchReveal's grace).
  const releaseLaunch = holdLaunchReveal();
  void api.gitStatus(projectId, sessionId ?? undefined)
    .then((st) => {
      if (stillCurrent()) store.setGitBranch(st.branch ?? "");
    })
    .catch(() => {
      if (stillCurrent()) store.setGitBranch("");
    })
    .finally(releaseLaunch);
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

/** The slice of `SyncClient` the store subscription needs. */
export interface SyncScopeClient {
  setSubscription(sessionId: string | undefined, afterSeq: number, projectId?: string): void;
}

/** The reader lost access to a chat (sharing changed under them): its row
 *  leaves, and an open chat closes with a calm word instead of failing on
 *  its next read. */
export function handleSessionRemoved(sessionId: string): void {
  const wasActive = store.getState().activeSessionId === sessionId;
  store.removeSession(sessionId);
  if (!wasActive) return;
  store.activateSession(null);
  store.setUiError(tr("sharing.lostAccess"), null, undefined, "info");
}

/** Resubscribe the socket only when the connection scope actually changes.
 *  `activeSessionId`/`activeProjectId` are `null` when absent; both are
 *  normalized to `undefined` before comparison, so an ordinary store update on
 *  New Chat never re-sends the subscription (the pre-fix bug compared raw
 *  `null` against a stored `undefined` and resubscribed on every update until
 *  the server closed the socket with 1008). Returns the unsubscribe function. */
export function subscribeSyncScope(client: SyncScopeClient): () => void {
  let lastSessionId: string | undefined;
  let lastProjectId: string | undefined;
  return store.subscribeStore(() => {
    const s = store.getState();
    const sessionId = s.activeSessionId ?? undefined;
    const projectId = s.activeProjectId ?? undefined;
    if (sessionId !== lastSessionId || projectId !== lastProjectId) {
      lastSessionId = sessionId;
      lastProjectId = projectId;
      client.setSubscription(
        sessionId,
        s.activeSessionId ? store.lastSeq(s.activeSessionId) : 0,
        projectId,
      );
    }
  });
}

export function init(): Promise<void> {
  // A capability dragged out of a window (a Custom actions tile) turns the
  // icon rails into drop targets; the host owns that bridge, not the package.
  if (!externalCapabilityDragInstalled) {
    externalCapabilityDragInstalled = true;
    installExternalCapabilityDrag();
  }
  // PWA installability is independent from the opt-in push subscription.
  // Auth has already succeeded before init(), so register without prompting.
  void registerServiceWorker()
    .then(() => reconcilePushSubscription())
    .catch((err) => console.warn("push registration reconcile failed", err));
  // Project presentation records are server-backed, while the existing local
  // records remain the synchronous/offline rendering path.
  initProjectPresentationSync(store.subscribeStore, () => store.workspaceProjectId(store.getState()));
  if (!runtimeCatalogInvalidationSubscribed) {
    runtimeCatalogInvalidationSubscribed = true;
    subscribeRuntimeCatalogInvalidations(() => {
      runtimeCatalogGeneration++;
      runtimeCatalogHydratedProjectId = null;
      modelsFetchInFlight?.controller.abort();
      modelsFetchInFlight = undefined;
      agentsFetchInFlight = undefined;
      if (!store.getState().activeProjectId) return;
      hydrateRuntimeCatalog();
    });
  }
  // Boot: project, model, and agent hydration launch
  // independently and publish as soon as each settles. Awaiting a combined
  // Promise.all/allSettled before publishing any result is forbidden — a slow
  // or failed catalog request can never delay, erase, or roll back projects.
  const initialHydration = refreshProjects("initial");
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
    // Browser boot waits for the restored project identity so the persisted
    // aggregate catalog is Space-safe and can be reused without an HTTP probe.
    runtimeCatalogPolicy = "project";
    if (store.getState().activeProjectId) hydrateRuntimeCatalog();
  }
  startSync();
  // Shared client preferences: pull the server copy, then mirror local edits
  // and apply changes made on other devices.
  initSettingsSync();
  // Browser/native local notifications are the fallback path when remote Web
  // Push is unavailable. Hidden pages defer to a confirmed Web Push delivery
  // to avoid duplicate OS notifications.
  installNotify();
  // Notification clicks from the service worker land here when a tab
  // already exists (postMessage instead of a second window).
  installPushDeepLinks(openSession);
  if (sync) subscribeSyncScope(sync);
  store.subscribeStore(() => {
    const s = store.getState();
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
      // (project, worktree) pair. Switches between
      // sessions of the same checkout reuse the label without a request.
      fetchBranch(s.activeProjectId, s.activeSessionId);
    }
  });
  return initialHydration;
}

// ---- project registry hydration -------------------------------------------

export type ProjectRefreshReason = "initial" | "manual" | "reconcile" | "reconnect";

let bootRestored = false;
let reconcileRetryTimer: ReturnType<typeof setTimeout> | undefined;
let projectRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let projectRecoveryAttempt = 0;
const PROJECT_RECOVERY_DELAYS_MS = [250, 750, 2_000, 5_000] as const;

function projectRecoveryHint(): string | null {
  const snapshot = store.getState();
  const contextual = store.workspaceProjectId(snapshot);
  if (contextual) return contextual;
  const routed = parseAppUrl(location.pathname, location.search).projectId;
  if (routed) return routed;
  try { return localStorage.getItem("polyth.activeProjectId") || null; }
  catch { return null; }
}

function scheduleProjectRecovery(): boolean {
  if (projectRecoveryTimer !== undefined) return true;
  const delay = PROJECT_RECOVERY_DELAYS_MS[projectRecoveryAttempt];
  if (delay === undefined) return false;
  projectRecoveryAttempt += 1;
  projectRecoveryTimer = setTimeout(() => {
    projectRecoveryTimer = undefined;
    void refreshProjects("reconnect");
  }, delay);
  return true;
}

function clearProjectRecovery(): void {
  projectRecoveryAttempt = 0;
  if (projectRecoveryTimer !== undefined) {
    clearTimeout(projectRecoveryTimer);
    projectRecoveryTimer = undefined;
  }
}

/** Generation-safe project refresh: increment the request id and capture the
 *  mutationVersion (store ticket), publish only when the response is still
 *  current, and reconcile once when a mutation superseded the captured data.
 *  Initial failure publishes `failed`; a refresh failure keeps the ready
 *  snapshot and exposes a retryable, non-blocking refresh error. */
export async function refreshProjects(reason: ProjectRefreshReason = "manual"): Promise<void> {
  const ticket = store.beginProjectListRequest();
  try {
    let projects = await api.listProjects();
    // A selected/deep-linked project and an empty project list contradict each
    // other during server/Space startup reconciliation. Do not publish the
    // transient empty snapshot as canonical truth: it would turn every
    // project-scoped pane into "No project selected" and boot URL sync would
    // erase the only route evidence. Retry with a short bounded backoff.
    if (projects.length === 0 && projectRecoveryHint() !== null && scheduleProjectRecovery()) return;
    // A truly empty registry starts in the person's own project instead of a
    // folder picker. The registry stays "loading" meanwhile, so the picker
    // never flashes; a refusal publishes the empty list and the picker opens.
    if (projects.length === 0) projects = await startPersonalProject();
    if (projects.length > 0) clearProjectRecovery();
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

/** The first-run personal project, at most one attempt per document. */
async function startPersonalProject(): Promise<Project[]> {
  if (!claimPersonalProjectAttempt()) return [];
  try {
    return [await api.ensurePersonalProject(tr("personalproject.name"))];
  } catch (err) {
    console.warn("personal project unavailable; offering the folder picker", err);
    return [];
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
    const fromUrl = parseAppUrl(location.pathname, location.search);
    const localSavedProjectId = (() => {
      try { return localStorage.getItem("polyth.activeProjectId") || null; }
      catch { return null; }
    })();

    // Do not leave a ready project registry project-less while waiting for
    // native/account-scoped persistence. The URL/local synchronous selection
    // is already authoritative enough to mount Git/Terminal/Files/Browser;
    // account-scoped navigation can refine the choice when it arrives.
    const immediate = resolveActiveProjectId(projects, {
      urlProjectId: fromUrl.projectId ?? null,
      localSavedProjectId,
    });
    if (immediate) store.activateProject(immediate);

    const restoredNavigation = await store.hydrateClientNavigation();
    const expectedProjectId = fromUrl.projectId
      ?? restoredNavigation?.projectId
      ?? localSavedProjectId;
    if (projects.length === 0 && expectedProjectId && scheduleProjectRecovery()) return;
    bootRestored = true;

    const initial = resolveActiveProjectId(projects, {
      urlProjectId: fromUrl.projectId ?? null,
      savedProjectId: restoredNavigation?.projectId ?? null,
      localSavedProjectId,
    });
    if (initial && initial !== store.getState().activeProjectId) store.activateProject(initial);
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
      const project = projects.find((candidate) => candidate.id === initial);
      const savedSession = restoredNavigation?.projectId === initial
        && restoredNavigation.spaceId === (project?.spaceId ?? "default")
        ? restoredNavigation.sessionId
        : undefined;
      if (savedSession) {
        await openSession(savedSession, { showChat: false }).catch(() => {});
      } else {
        const restored = await store.hydrateNewSessionDraft(initial);
        if (restored) store.startNewSession(initial, restored);
      }
    }
    store.reconcileWorkspaceProjectFromSession();
    startUrlSync();
    return;
  }

  // Later refresh: keep the current active project when it still exists,
  // otherwise resolve a replacement (or none when the registry emptied).
  const snapshot = store.getState();
  const active = store.workspaceProjectId(snapshot);
  if (active && !projects.some((p) => p.id === active)) {
    store.activateProject(projects[0]?.id ?? null);
  } else if (!snapshot.activeProjectId) {
    store.reconcileWorkspaceProjectFromSession();
    if (!store.getState().activeProjectId && projects.length > 0) {
      store.activateProject(projects[0]!.id);
    }
  }
}

// An empty model catalog blocks the composer ("No models available" +
// disabled send), and a backend that is still starting — or restarting under
// the page — legitimately answers empty/with an error for a while. Latching
// that first answer bricked session creation until a manual reload (QA P0).
// Retry with capped backoff until a non-empty catalog lands; a WS (re)connect
// also re-checks immediately, so recovery follows the backend, not a timer.
const MODEL_RETRY_BASE_MS = 250;
const MODEL_RETRY_MAX_MS = 5_000;
// Inspect + serve listen + health + /provider can exceed 8s on a cold
// 100MB+ OpenCode binary. Aborting earlier turns a still-spawning runtime
// into "No models available" even though the backend is coming up.
const MODEL_REQUEST_TIMEOUT_MS = 45_000;
let modelRetryTimer: ReturnType<typeof setTimeout> | undefined;
let modelRetryDelay = MODEL_RETRY_BASE_MS;
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
  const projectId = store.getState().activeProjectId;
  if (!projectId || runtimeCatalogHydratedProjectId !== projectId) return;
  if (store.getState().models.length > 0) return;
  if (modelRetryTimer !== undefined) {
    clearTimeout(modelRetryTimer);
    modelRetryTimer = undefined;
  }
  modelRetryDelay = MODEL_RETRY_BASE_MS;
  // A runtime that died during startup can leave its HTTP request pending. Do
  // not make recovery wait for the browser's much longer fetch timeout.
  if (modelsFetchInFlight?.projectId === projectId) {
    modelRetryRequested = true;
    modelsFetchInFlight.controller.abort();
    return;
  }
  void refreshModels(projectId);
  void refreshAgents(projectId);
}

let modelsFetchInFlight: { projectId: string; controller: AbortController } | undefined;

async function refreshModels(projectId = store.getState().activeProjectId ?? undefined): Promise<void> {
  if (!projectId) return;
  if (modelsFetchInFlight?.projectId === projectId) return;
  // A project switch fences the old aggregate request instead of letting it
  // block the new project's first paint or publish into the wrong store.
  modelsFetchInFlight?.controller.abort();
  const request = { projectId, controller: new AbortController() };
  modelsFetchInFlight = request;
  const requestGeneration = runtimeCatalogGeneration;
  const timeout = setTimeout(() => request.controller.abort(), MODEL_REQUEST_TIMEOUT_MS);
  try {
    const models = await api.listModels(request.controller.signal);
    if (requestGeneration !== runtimeCatalogGeneration
      || store.getState().activeProjectId !== projectId) return;
    store.setModels(models);
    if (models.length > 0) {
      rememberPersistedRuntimeModels(projectId, models);
      if (modelRetryTimer !== undefined) clearTimeout(modelRetryTimer);
      modelRetryTimer = undefined;
      modelRetryDelay = MODEL_RETRY_BASE_MS;
      return;
    }
    void refreshRuntimeDiagnostics();
    scheduleModelRetry();
  } catch (err) {
    // Project onboarding continues; the composer catalog owns its own state.
    if (!request.controller.signal.aborted) console.error("list models failed", err);
    if (modelsFetchInFlight === request && store.getState().activeProjectId === projectId) {
      void refreshRuntimeDiagnostics();
      if (!modelRetryRequested) scheduleModelRetry();
    }
  } finally {
    clearTimeout(timeout);
    if (modelsFetchInFlight === request) {
      modelsFetchInFlight = undefined;
      if (modelRetryRequested) {
        modelRetryRequested = false;
        void refreshModels();
        void refreshAgents();
      }
    }
  }
}

/** An empty catalog has many causes; the server knows which one. Asked only on
 *  an empty answer so a healthy boot never pays for it, and never allowed to
 *  fail the retry loop — a missing reason just leaves the generic guidance. */
async function refreshRuntimeDiagnostics(): Promise<void> {
  try {
    const { runtimes } = await api.runtimeDiagnostics();
    // A late answer must not contradict a catalog that already arrived.
    if (store.getState().models.length > 0) return;
    store.setRuntimeUnavailable(runtimes[0] ?? null);
  } catch {
    // Older/remote servers may not expose the route; stay on the generic note.
  }
}

let agentsFetchInFlight: { projectId: string } | undefined;

async function refreshAgents(projectId = store.getState().activeProjectId ?? undefined): Promise<void> {
  if (!projectId || agentsFetchInFlight?.projectId === projectId) return;
  const request = { projectId };
  agentsFetchInFlight = request;
  const requestGeneration = runtimeCatalogGeneration;
  try {
    const agents = await api.listAgents();
    if (requestGeneration !== runtimeCatalogGeneration
      || store.getState().activeProjectId !== projectId) return;
    store.setAgents(agents);
    rememberPersistedRuntimeAgents(projectId, agents);
  } catch (err) {
    if (store.getState().activeProjectId === projectId) console.error("list agents failed", err);
  } finally {
    if (agentsFetchInFlight === request) agentsFetchInFlight = undefined;
  }
}

function startSync(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  sync = new SyncClient({
    manualAcknowledgement: true,
    syncReceipts: true,
    refreshSessionIds: () => sessionIdsToRefresh(store.getState().sessions),
  });
  sync.setRetryHints({
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    foreground: typeof document === "undefined" || document.visibilityState !== "hidden",
  });
  sync.onStatus(publishSyncStatus);
  sync.onFreshness(publishSyncFreshness);
  window.addEventListener("online", () => sync?.setRetryHints({ online: true }));
  window.addEventListener("offline", () => sync?.setRetryHints({ online: false }));
  document.addEventListener("visibilitychange", () => {
    setSyncForeground(document.visibilityState !== "hidden");
    // What arrived in the open chat while the page was hidden is read now.
    if (document.visibilityState !== "hidden") markActiveSessionRead();
  });
  window.addEventListener("polyth:refresh-projects", () => {
    void refreshProjects("manual");
  });
  // Canonical ingestion is deliberately slower than paint. The first streamed
  // chunk after a quiet spell lands immediately; sustained text/reasoning is
  // folded into one store publication per 100ms. Control/tool/terminal events
  // are barriers and flush immediately, so responsiveness is unchanged.
  const ingestion = createEventIngestionBatcher((events, liveKeys) => {
    store.applyEvents(events, { notifyEventKeys: liveKeys });
    sync?.acknowledge(events);
  });
  sync.onEvent((msg) => {
    if (msg.type === "event") {
      ingestion.pushLive(msg.event);
      if (signalsStaleModelCatalog(msg.event)) refreshStaleModelCatalog();
    } else if (msg.type === "events") {
      if (msg.live === true) {
        for (const event of msg.events) ingestion.pushLive(event);
        if (msg.events.some(signalsStaleModelCatalog)) refreshStaleModelCatalog();
      } else {
        // Gap-fill is already batched by the server. Apply it as replay history
        // after any pending live stream so canonical order stays visible while
        // package presentation observers remain quiet.
        ingestion.pushReplay(msg.events);
      }
    } else if (msg.type === "projection") {
      handleProjectionBatch([msg.session]);
      // The user just watched a turn end in the active session — the tail is
      // read. (Streaming "working" broadcasts are skipped; leaving mid-stream
      // leaves the cursor behind, which is exactly the unread-bold state.)
      if (
        msg.session.status !== "working"
        && msg.session.id === store.getState().activeSessionId
      ) markActiveSessionRead();
    } else if (msg.type === "projections") {
      handleProjectionBatch(msg.sessions);
    } else if (msg.type === "notification/added") {
      // NTF-01: global inbox rows bypass the session event batch entirely —
      // they are derived state, never part of any session's log or reducer.
      notificationCentre.append(msg.notification);
      // A person's message or mention: a banner, an OS alert or — when the
      // person is reading that chat — nothing at all.
      alertPersonMessage(msg.notification);
    } else if (msg.type === "worktrees/changed") {
      // One repository's worktree topology moved. Bump only that project so
      // the surfaces listing its worktrees re-read; every other project's
      // list is untouched.
      store.bumpWorktreeTopology(msg.projectId);
    } else if (msg.type === "session/removed") {
      handleSessionRemoved(msg.sessionId);
    } else if (msg.type === "package/changed") {
      reconcilePackage(msg.package);
    } else if (msg.type === "client-settings/changed") {
      // A settings change from another device — apply it live (theme, density,
      // interface scale, …). Echoes of this device's own change are dropped by
      // revision inside settingsSync.
      applyRemoteClientSettings(msg.settings);
    } else if (msg.type === "project-presentation/changed") {
      applyRemoteProjectPresentation(msg.projectId, msg.settings);
    } else if (msg.type === "error") {
      // Protocol/record failures are authoritative server messages. Surface
      // them instead of translating the following close into a generic retry.
      store.setUiError(msg.message);
    }
  });
  // Gap-fill on every successful (re)connect; merge-by-id makes the race with
  // the initial bootstrap fetch safe. No polling.
  sync.onOpen(() => {
    // Priority: the screen first. The socket is already replaying the open
    // session; background reads join once it is current (bounded wait).
    afterSessionCatchUp(() => {
      void notificationCentre.catchUp();
      // A request that overlapped server drain is not an authoritative empty
      // profile list. Rehydrate the account cache when transport is healthy.
      void refreshProfiles().catch(() => undefined);
      // A reconnect after backend churn is the moment an empty model catalog
      // becomes fetchable again — heal it now instead of waiting out a backoff.
      recheckRuntimeCatalog();
      retryUnavailableRuntimeCatalogs();
    });
    // Re-pull shared settings: a broadcast may have been missed while the
    // socket was down. Immediate — it can change how the screen looks.
    initSettingsSync();
    initProjectPresentationSync(store.subscribeStore, () => store.workspaceProjectId(store.getState()));
    store.reconcileWorkspaceProjectFromSession();
    const snapshot = store.getState();
    if (shouldRefreshProjectsOnSyncOpen(
      snapshot.projectRegistry,
      store.workspaceProjectId(snapshot),
      projectRecoveryHint(),
    )) {
      void refreshProjects("reconnect");
    }
    const activeSessionId = snapshot.activeSessionId;
    if (activeSessionId) void reconcileClientMutation(activeSessionId);
    // Views whose read failed while the link was down (a phone back from the
    // background) load again now rather than keeping "Load failed".
    window.dispatchEvent(new Event(CONNECTION_RESTORED_EVENT));
  });
  void initPluginBridge(sync).then(() => {
    const page = settingsPageFromSearch(location.search);
    if (!page) return;
    store.openSettingsPage(page);
    const url = new URL(location.href);
    url.searchParams.delete("settings");
    const search = url.searchParams.toString();
    history.replaceState(history.state, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
  }).catch((error) => {
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
/** Open-critical reads fail instead of waiting forever on a stalled connection
 *  (a mobile network handoff); the open then reports an error to retry. */
const SESSION_READ_TIMEOUT_MS = 15_000;
const boundedRead = (): RequestInit => ({ signal: deadlineSignal(SESSION_READ_TIMEOUT_MS) });
const backfillInFlight = new Map<string, Promise<boolean>>();
const tailRequests = new Map<string, { passive: boolean; promise: Promise<SessionEvent[]> }>();
const prefetchedSessions = new Set<string>();

/** `bounded` gives every page the same deadline as the cold tail read, so a
 *  stalled connection fails the poll instead of pinning its `tailRequests` slot. */
async function applyForwardReplay(sessionId: string, afterSeq: number, isCurrent: () => boolean, bounded = false): Promise<void> {
  let cursor = afterSeq;
  let highWater: number | undefined;
  while (isCurrent()) {
    const page = await api.getReplayPage(sessionId, cursor, highWater, bounded ? deadlineSignal(SESSION_READ_TIMEOUT_MS) : undefined);
    if (!isCurrent()) return;
    if (highWater !== undefined && page.highWater !== highWater) throw new Error("Replay boundary changed");
    highWater = page.highWater;
    for (const event of page.events) {
      if (event.sessionId !== sessionId || event.seq !== cursor + 1) throw new Error("Replay sequence gap");
      cursor = event.seq;
    }
    if (page.cursor !== cursor || (!page.complete && page.events.length === 0)) throw new Error("Replay made no progress");
    store.applyEvents(page.events, { notifySessionEvents: false });
    if (page.complete) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const sessionRuntimeWarm = createSessionRuntimeWarm({
  activate: (sessionId, intent) => api.activateSession(sessionId, intent),
  activeSessionId: () => store.getState().activeSessionId,
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  onOpenError: (_sessionId, error) => store.setUiError(friendlyError("Open session", error)),
});

/** The person opened this session. Its native runtime starts only for pending
 *  work; a quiet chat is warmed after a short dwell or on typing. */
export function activateRuntime(sessionId: string): void {
  sessionRuntimeWarm.opened(sessionId);
}

/** The person is writing in this session's composer: warm its runtime now. */
export function warmSessionRuntime(sessionId: string): void {
  sessionRuntimeWarm.typing(sessionId);
}

function requestSessionTail(
  sessionId: string,
  passive: boolean,
  afterSeq = 0,
): Promise<SessionEvent[]> {
  const existing = tailRequests.get(sessionId);
  if (existing) return existing.promise;
  markSessionPerformance("request_started", sessionId);
  // A cold request asks for the newest bounded window. Once a tail is cached,
  // a poll reads the complete suffix so it cannot create a sequence gap when
  // a busy background session emits more than one window between polls.
  const scope = scopedDraftCacheKey(sessionId);
  const request = (afterSeq === 0
    ? api.getEvents(sessionId, 0, { limit: INITIAL_EVENT_WINDOW, prefetch: passive }, boundedRead())
    : applyForwardReplay(sessionId, afterSeq, () => scopedDraftCacheKey(sessionId) === scope, true).then(() => [] as SessionEvent[]))
    .then((events) => {
      if (scopedDraftCacheKey(sessionId) !== scope) return [];
      markSessionPerformance("response_received", sessionId);
      const active = store.getState().activeSessionId;
      if (active) store.touchSessionCache(active);
      store.touchSessionCache(sessionId);
      store.applyEvents(events, { notifySessionEvents: false });
      store.ensureEventCache(sessionId);
      rememberSessionHint(hydratedSessions, sessionId);
      markSessionPerformance("messages_ingested", sessionId);
      return events;
    })
    .finally(() => {
      if (tailRequests.get(sessionId)?.promise === request) tailRequests.delete(sessionId);
    });
  tailRequests.set(sessionId, { passive, promise: request });
  return request;
}

/** Sessions already warmed this page lifetime. The event LRU holds only 12
 *  sessions, so a list warming more rows evicts its own earlier warms; warming
 *  those again on the next render re-requested them forever (the phone island
 *  saturated its link and pegged the server). An open fetches what it needs. */
const warmedTails = new Set<string>();

/** Pointer intent warms only the canonical SQLite tail, at most once per
 *  session. It never activates, routes, reports an error, or touches the
 *  runtime/import path. */
export function prefetchSessionTail(sessionId: string): void {
  const s = store.getState();
  if (warmedTails.has(sessionId) || (hydratedSessions.has(sessionId) && s.events[sessionId] !== undefined)) return;
  // At the in-flight cap the row stays unwarmed, so a later intent can warm it.
  if (tailRequests.size >= 4 && !tailRequests.has(sessionId)) return;
  rememberSessionHint(warmedTails, sessionId);
  rememberSessionHint(prefetchedSessions, sessionId);
  void requestSessionTail(sessionId, true).catch(() => {
    // A failed warm is not retried (see warmedTails); only the hint is dropped.
    prefetchedSessions.delete(sessionId);
  });
}

/** Revalidate an already-prefetched background tail without activating it.
 *  The mobile session overview uses this only for active placeholder-titled
 *  rows, whose first durable user message can arrive after the initial empty
 *  prefetch. Applying that suffix lets the normal store title projection
 *  update the row without making a navigation read interactive. */
export async function pollSessionTail(sessionId: string): Promise<void> {
  rememberSessionHint(prefetchedSessions, sessionId);
  try {
    await requestSessionTail(sessionId, true, store.lastSeq(sessionId));
  } catch (error) {
    prefetchedSessions.delete(sessionId);
    throw error;
  }
}

/** Keep a background chat on screen current without activating it: the split
 *  view's companion pane. A first read takes the newest window; later reads
 *  take the complete suffix after the cached tail. The socket follows only
 *  the active chat, so the pane calls this as its projection moves. Rejects
 *  with the request's error (a 404 means the chat is gone). */
export async function refreshBackgroundSession(sessionId: string): Promise<void> {
  const cached = store.getState().events[sessionId] !== undefined && hydratedSessions.has(sessionId);
  rememberSessionHint(prefetchedSessions, sessionId);
  await requestSessionTail(sessionId, true, cached ? store.lastSeq(sessionId) : 0);
}

async function reconcileSession(sessionId: string, afterSeq: number, generation: number): Promise<void> {
  const cachedBase = store.getState().events[sessionId] ?? [];
  const projectionAtRequest = store.getState().sessions.find((session) => session.id === sessionId);
  markSessionPerformance("request_started", sessionId);
  const session = await api.getSession(sessionId);
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
  // the immutable cached base before its paged suffix so no gap appears.
  store.applyEvents(cachedBase, { notifySessionEvents: false });
  // The selected socket owns replay. HTTP fills only while no socket owns it.
  if (sync?.getStatus() !== "connected") {
    await applyForwardReplay(sessionId, afterSeq, () => generation === openSessionGeneration && sync?.getStatus() !== "connected");
  }
  if (generation !== openSessionGeneration) return;
  store.ensureEventCache(sessionId);
  rememberSessionHint(hydratedSessions, sessionId);
  prefetchedSessions.delete(sessionId);
  markSessionPerformance("messages_ingested", sessionId);
}

/** Fetch one chunk of history older than the cached window. Returns true when
 *  events were added, false at log start. Concurrent readers share the fetch. */
export async function loadOlderEvents(sessionId: string, chunk = BACKFILL_CHUNK): Promise<boolean> {
  const scope = scopedDraftCacheKey(sessionId);
  const generation = openSessionGeneration;
  const flightKey = JSON.stringify([scope, generation]);
  const existing = backfillInFlight.get(flightKey);
  if (existing) return existing;
  const oldest = store.oldestSeq(sessionId);
  if (oldest <= 1) return false; // nothing cached yet, or already at seq 1
  const request = api.getEvents(sessionId, 0, { beforeSeq: oldest, limit: chunk }).then((older) => {
    if (scope !== scopedDraftCacheKey(sessionId) || generation !== openSessionGeneration) return false;
    if (older.length === 0) return false;
    store.applyEvents(older, { notifySessionEvents: false });
    return true;
  });
  backfillInFlight.set(flightKey, request);
  try { return await request; }
  finally { if (backfillInFlight.get(flightKey) === request) backfillInFlight.delete(flightKey); }
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

// ---- unread tracking (navigator bold) ------------------------------------
// The server keeps a per-session read cursor; the client advances it only
// when the user is actually looking at the session: on open, and whenever a
// projection broadcast lands the ACTIVE session in a non-working state (the
// user watched the turn end). A session the user leaves mid-stream keeps its
// cursor behind the tail, so the completed session's last agent message
// stays unread (bold) in the navigator.
const lastMarkedSeq = new Map<string, number>();
function markActiveSessionRead(): void {
  // Only what is on screen is read: a hidden page leaves the chat unread (and
  // its mention badge lit) until the person comes back to it.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const sessionId = store.getState().activeSessionId;
  if (!sessionId) return;
  const seq = store.lastSeq(sessionId);
  if (seq <= 0) return;
  if (lastMarkedSeq.get(sessionId) === seq) return; // already marked at this seq
  lastMarkedSeq.set(sessionId, seq);
  if (lastMarkedSeq.size > 64) lastMarkedSeq.delete(lastMarkedSeq.keys().next().value!);
  void api.markSessionRead(sessionId, seq).catch(() => {});
}

// A delegated session is adopted asynchronously: the task snapshot can reach
// the browser a few milliseconds before its projection. Revalidate the
// project list once instead of sending the user to a dead deep link.
async function loadSessionForOpen(sessionId: string): Promise<SessionProjection> {
  const matches = (session: SessionProjection): boolean =>
    session.id === sessionId || session.backendSessionId === sessionId;
  const cached = store.getState().sessions.find(matches);
  if (cached && !cached.summary) return cached;
  try {
    return await api.getSession(sessionId, boundedRead());
  } catch (firstError) {
    const projectId = store.getState().activeProjectId;
    if (projectId) {
      store.upsertSessions(await api.listSessions(projectId, boundedRead()));
      const refreshed = store.getState().sessions.find(matches);
      if (refreshed) return refreshed;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      return await api.getSession(sessionId, boundedRead());
    } catch {
      if (projectId) {
        store.upsertSessions(await api.listSessions(projectId, boundedRead()));
        const refreshed = store.getState().sessions.find(matches);
        if (refreshed) return refreshed;
      }
      throw firstError;
    }
  }
}

export async function openSession(
  sessionId: string,
  opts: {
    /** User-driven switches (default) land in the session's chat view;
     *  non-pinned workspace windows close while pinned windows remain. Boot
     *  restoration passes false so the pinned companion stays visible. */
    showChat?: boolean;
  } = {},
): Promise<void> {
  const generation = ++openSessionGeneration;
  // A chat opened by the person replaces a page (an agent) at once, so the
  // loading row shows where the chat will be.
  if (opts.showChat !== false) store.closePage();
  const before = store.getState();
  const cachedSession = before.sessions.find((session) =>
    session.id === sessionId || session.backendSessionId === sessionId,
  );
  const cachedSessionId = cachedSession?.id ?? sessionId;
  // The events entry can be LRU-evicted while the id stays in hydratedSessions;
  // an evicted session re-hydrates exactly like a first open.
  const cachedEvents = before.events[cachedSessionId];
  const useCachedView = hydratedSessions.has(cachedSessionId) && cachedSession !== undefined && cachedEvents !== undefined;
  const afterSeq = useCachedView ? store.lastSeq(cachedSessionId) : 0;

  // Revisited sessions render their canonical cached history immediately while
  // metadata and the append-only suffix revalidate. A first open remains in
  // the loading state so an incomplete WS fragment can never masquerade as the
  // full log.
  if (useCachedView) {
    if (cachedSession.projectId !== before.activeProjectId) {
      store.setOpeningSession(sessionId);
      store.activateProject(cachedSession.projectId);
    }
    const hydrationClaim = store.getState();
    await hydrateComposerDraft(cachedSessionId);
    if (generation !== openSessionGeneration) return;
    const afterHydration = store.getState();
    if (afterHydration.activeProjectId !== hydrationClaim.activeProjectId
      || afterHydration.activeSessionId !== hydrationClaim.activeSessionId
      || afterHydration.newSessionIntent !== hydrationClaim.newSessionIntent
      || afterHydration.activePage !== hydrationClaim.activePage) return;
    void reconcileClientMutation(cachedSessionId, true);
    store.activateSession(cachedSessionId);
    activateRuntime(cachedSessionId);
    void loadRuntimeFeaturesForSession(cachedSessionId);
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
      || now.activeSessionId !== baseline.activeSessionId
      || now.activePage !== baseline.activePage;
  };
  try {
    if (useCachedView) {
      await reconcileSession(cachedSessionId, afterSeq, generation);
      if (generation === openSessionGeneration) {
        maybeSeedFromReplay(cachedSessionId);
        scheduleAutoBackfill(cachedSessionId, generation);
        if (store.getState().activeSessionId === cachedSessionId) markActiveSessionRead();
      }
      return;
    }
    // Resolve metadata first: delegated snapshots may carry the backend id
    // briefly, and the canonical id is required for the event-tail request.
    // Keep the two reads parallel; an alias tail is retried against the
    // canonical id after metadata resolves. The first window is a passive read
    // (milliseconds): an interactive one waits while the server materializes
    // and reconciles the native runtime — seconds for an old session. That
    // revalidation runs after the transcript is on screen, below.
    const sessionPromise = cachedSession && !cachedSession.summary ? cachedSession : loadSessionForOpen(sessionId);
    const tailPromise = requestSessionTail(sessionId, true)
      .then(() => ({ ok: true as const }))
      .catch(() => ({ ok: false as const }));
    const [session, initialTail] = await Promise.all([sessionPromise, tailPromise]);
    const resolvedSessionId = session.id;
    if (resolvedSessionId !== sessionId || !initialTail.ok) {
      await requestSessionTail(resolvedSessionId, true);
    }
    if (generation !== openSessionGeneration) return;
    store.upsertSession(session);
    store.ensureEventCache(resolvedSessionId); // empty logs still count as cached
    rememberSessionHint(hydratedSessions, resolvedSessionId);
    maybeSeedFromReplay(resolvedSessionId);
    if (!userNavigatedAway()) {
      if (session.projectId !== store.getState().activeProjectId) store.activateProject(session.projectId);
      const hydrationClaim = store.getState();
      await hydrateComposerDraft(resolvedSessionId);
      if (generation !== openSessionGeneration) return;
      const afterHydration = store.getState();
      if (afterHydration.activeProjectId !== hydrationClaim.activeProjectId
        || afterHydration.activeSessionId !== hydrationClaim.activeSessionId
        || afterHydration.newSessionIntent !== hydrationClaim.newSessionIntent
        || afterHydration.activePage !== hydrationClaim.activePage) return;
      void reconcileClientMutation(resolvedSessionId, true);
      store.activateSession(resolvedSessionId);
      activateRuntime(resolvedSessionId);
      void loadRuntimeFeaturesForSession(resolvedSessionId);
      if (opts.showChat !== false) store.showSessionChat();
      scheduleAutoBackfill(resolvedSessionId, generation);
      markActiveSessionRead();
      // Interactive revalidation (runtime materialization, queued-delivery
      // recovery, deferred history import) never holds the open; its suffix
      // lands through the normal event path when the server is done.
      void reconcileSession(resolvedSessionId, store.lastSeq(resolvedSessionId), generation).then(() => {
        // The suffix can carry events newer than the mark above — the user is
        // viewing, so those are read too.
        if (store.getState().activeSessionId === resolvedSessionId) markActiveSessionRead();
      }, (error: unknown) => console.warn("session revalidation failed", error));
    }
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

/** Replay-derived composer seeding: an active rewind marker
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
  // Recent chats on the fresh-chat screen come from this page; a launch
  // waits for it instead of showing the list grow in.
  const releaseLaunch = holdLaunchReveal();
  try {
    // Pinned chats are read on their own: the recency page holds only the
    // newest fifty, and an old pinned chat must not vanish from the list.
    const [page, pinned] = await Promise.all([
      api.listSessionSummaries({ projectId, limit: 50 }),
      api.listSessionSummaries({ projectId, pinned: true, limit: 100 }).catch((error: unknown) => {
        console.warn("list pinned sessions failed", error);
        return undefined;
      }),
    ]);
    // A partial page cannot delete known sessions, folders, or active details.
    store.upsertSessions(pinned ? [...page.sessions, ...pinned.sessions] : page.sessions);
  } catch (err) {
    console.error("list sessions failed", err);
  } finally {
    releaseLaunch();
  }
}

// Add/Create ordering: the POST response is authoritative for
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

/** Clone a repository, then activate the server-authoritative project record. */
export async function cloneProject(input: ProjectCloneInput): Promise<Project> {
  const p = await api.cloneProject(input);
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

/** Optimistic: the new name shows at once (the registry mutation version
 *  discards list responses captured before it); a rejection restores the old
 *  name unless something else renamed the project meanwhile. */
export async function renameProject(id: string, name: string): Promise<void> {
  const previous = store.getState().projectRegistry.projects.find((project) => project.id === id);
  if (previous) store.applyProjectUpsert({ ...previous, name });
  try {
    const updated = await api.patchProject(id, { name });
    store.applyProjectUpsert(updated);
  } catch (error) {
    const current = store.getState().projectRegistry.projects.find((project) => project.id === id);
    if (previous && current?.name === name) store.applyProjectUpsert({ ...current, name: previous.name });
    throw error;
  }
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

/** Optimistic project-defaults save: the control shows the new value at once
 *  (null clears a default, as on the server); one PATCH follows. A rejection
 *  restores the previous defaults unless another change replaced them, then
 *  rethrows for the caller's notice. */
export async function saveProjectDefaultsOptimistic(id: string, defaults: ProjectDefaults): Promise<void> {
  const find = () => store.getState().projectRegistry.projects.find((project) => project.id === id);
  const previous = find();
  let preview: ProjectDefaults | undefined;
  if (previous) {
    const merged: Record<string, unknown> = { ...previous.defaults };
    for (const [key, value] of Object.entries(defaults)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }
    preview = merged as ProjectDefaults;
    store.applyProjectUpsert({ ...previous, defaults: preview });
  }
  try {
    store.applyProjectUpsert(await api.patchProject(id, { defaults }));
  } catch (error) {
    const current = find();
    if (previous && current && current.defaults === preview) {
      const restored: Project = { ...current };
      if (previous.defaults === undefined) delete restored.defaults;
      else restored.defaults = previous.defaults;
      store.applyProjectUpsert(restored);
    }
    throw error;
  }
}

type ProjectAppearanceFields =Pick<Project, "name" | "color" | "icon" | "greeting" | "composition">;

/** Optimistic appearance save: the name, colour and greeting show at once;
 *  `prepare` may still resolve slow parts (the icon is fetched and inlined)
 *  before the one PATCH. A rejection restores every field that nothing else
 *  changed meanwhile, then rethrows for the caller's notice. */
export async function saveProjectAppearanceOptimistic(
  id: string,
  preview: Partial<ProjectAppearanceFields>,
  prepare: () => Promise<ProjectPatch>,
): Promise<void> {
  const find = () => store.getState().projectRegistry.projects.find((project) => project.id === id);
  const previous = find();
  if (previous) store.applyProjectUpsert({ ...previous, ...preview });
  try {
    const updated = await api.patchProject(id, await prepare());
    store.applyProjectUpsert(updated);
  } catch (error) {
    const current = find();
    if (previous && current) {
      const restored: Project = { ...current };
      for (const key of Object.keys(preview) as (keyof ProjectAppearanceFields)[]) {
        if (current[key] !== preview[key]) continue;
        if (previous[key] === undefined) delete restored[key];
        else (restored as unknown as Record<string, unknown>)[key] = previous[key];
      }
      store.applyProjectUpsert(restored);
    }
    throw error;
  }
}

/** Save a composer choice only for projects that opted into model memory. */
export async function rememberProjectModelSelection(id: string, model: ModelRef & { harnessId?: string }): Promise<void> {
  const project = store.getState().projectRegistry.projects.find((candidate) => candidate.id === id);
  if (!projectRemembersModelSelection(project?.defaults)) return;
  const updated = await api.patchProject(id, {
    defaults: { rememberModelSelection: true, model },
  });
  store.applyProjectUpsert(updated);
}

/** Optimistic: the project leaves the registry (and, when active, hands the
 *  workspace to its replacement) before the server answers. A rejection puts
 *  it back, reactivates it if the person is still on the replacement, and
 *  rethrows for the caller's notice; the reconcile list restores order. */
export async function removeProject(id: string): Promise<void> {
  const before = store.getState();
  const previous = before.projectRegistry.projects.find((project) => project.id === id);
  if (previous) store.applyProjectRemoved(id);
  const replacement = store.getState().activeProjectId;
  try {
    await api.deleteProject(id);
    if (!previous) store.applyProjectRemoved(id);
  } catch (error) {
    if (previous && !store.getState().projectRegistry.projects.some((project) => project.id === id)) {
      store.applyProjectUpsert(previous);
      if (before.activeProjectId === id && store.getState().activeProjectId === replacement) store.activateProject(id);
    }
    throw error;
  } finally {
    void refreshProjects("reconcile");
  }
}

export interface CreateSessionOptions {
  repositoryIds?: readonly string[];
  harness?: HarnessSelection;
  title?: string;
  model?: ModelRef;
  agent?: string;
  /** Active chat lane. Omitted for an ordinary conversation. */
  purpose?: string;
  worktreePath?: string;
  /** Start loading the chat without waiting for its initial replay. */
  precache?: boolean;
  /** Decided once the id is authoritative: open the new chat (default) or
   *  leave it running in the background because the user navigated away.
   *  Receives the new id before anything is focused. */
  activate?: (sessionId: string) => boolean;
  /** Nothing was chosen for this chat and the person has this usable default
   *  harness (Spaces §13): send no harness, model or agent and fill no
   *  project/session defaults, so the server pins the chat to it. */
  personDefaultHarnessId?: string;
}

export interface IsolatedSessionOptions {
  repositoryIds?: readonly string[];
  harness?: HarnessSelection;
  title?: string;
  model?: ModelRef;
  agent?: string;
  /** Active chat lane. Omitted for an ordinary conversation. */
  purpose?: string;
  targetBranch?: string;
  sourceSessionId?: string;
  precache?: boolean;
  activate?: (sessionId: string) => boolean;
  /** As for `createSession`. An isolated chat is created by the server's
   *  isolation service, which can't see a person default, so the harness is
   *  named instead (no model or agent: the harness's own default applies). */
  personDefaultHarnessId?: string;
}

/** A create that follows the person default carries no route of its own. */
function withoutRoute<T extends { harness?: unknown; model?: unknown; agent?: unknown }>(input: T): Omit<T, "harness" | "model" | "agent"> {
  const { harness: _harness, model: _model, agent: _agent, ...rest } = input;
  return rest;
}

function compatibleCreationDefaults(
  project: Project | undefined,
  options: Pick<CreateSessionOptions, "harness" | "model" | "agent">,
): { model?: ModelRef; agent?: string } {
  const defaults = getSessionDefaults();
  const candidateModel = options.model ?? resolveProjectModelDefault(project?.defaults, defaults.defaultModel);
  const candidateAgent = options.agent ?? project?.defaults?.agent ?? defaults.defaultAgent;
  const pinnedHarness = options.harness?.mode === "pinned" ? options.harness.harnessId : undefined;
  if (!pinnedHarness) return {
    ...(candidateModel ? { model: candidateModel } : {}),
    ...(candidateAgent ? { agent: candidateAgent } : {}),
  };
  const state = store.getState();
  const model = candidateModel && state.models.some((item) =>
    item.harnessId === pinnedHarness
    && item.providerID === candidateModel.providerID
    && item.modelID === candidateModel.modelID) ? candidateModel : undefined;
  const agent = candidateAgent && state.agents.some((item) =>
    item.harnessId === pinnedHarness && item.name === candidateAgent) ? candidateAgent : undefined;
  return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
}

/** Create a session in a Polyth-managed isolated workspace and open it. */
export async function startIsolatedSession(
  projectId: string,
  opts: IsolatedSessionOptions = {},
): Promise<string> {
  const { precache = false, activate, personDefaultHarnessId, ...requested } = opts;
  const input: typeof requested = personDefaultHarnessId
    ? { ...withoutRoute(requested), harness: { mode: "pinned", harnessId: personDefaultHarnessId } }
    : requested;
  const project = store.getState().projectRegistry.projects.find((candidate) => candidate.id === projectId);
  const { model, agent } = personDefaultHarnessId ? {} : compatibleCreationDefaults(project, opts);
  let sessionId: string;
  try {
    const isolated = {
      projectId,
      ...(input.harness ? { harness: input.harness } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(input.targetBranch ? { targetBranch: input.targetBranch } : {}),
      ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      ...(input.repositoryIds ? { repositoryIds: input.repositoryIds } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    };
    // Keyed like createSession: a lost response resolves to the session (and
    // its managed worktree) the request made; a resend never allocates twice.
    ({ id: sessionId } = await createSessionWithRecovery({
      create: (clientOperationId) => api.createIsolatedSession({ ...isolated, clientOperationId }),
      status: (clientOperationId) => api.sessionCreateOperation(clientOperationId),
    }));
  } catch (error) {
    cleanupFailedStartupSessionFromError(error);
    throw error;
  }
  await publishCreatedSession({
    id: sessionId,
    projectId,
    title: input.title ?? "",
    ...(input.harness ? { harness: input.harness } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
  }, { precache, activate });
  return sessionId;
}

/** Instant spawn (UX): the id is authoritative and the session is seconds
 *  old, so publish an optimistic projection + empty canonical event window and
 *  open the chat NOW. openSession() then revalidates through its cached path in
 *  the background (metadata + any suffix), and refreshSessions reconciles the
 *  projection — zero blocking round trips after the POST. A user who navigated
 *  away meanwhile keeps their place; the session is listed, not focused. */
async function publishCreatedSession(
  seed: Omit<SessionProjection, "status" | "createdAt" | "updatedAt">,
  opts: { precache: boolean; activate: ((sessionId: string) => boolean) | undefined },
): Promise<void> {
  const now = Date.now();
  const { id: sessionId, projectId } = seed;
  store.seedSessionCache({ ...seed, status: "idle", createdAt: now, updatedAt: now });
  rememberSessionHint(hydratedSessions, sessionId);
  if (opts.activate && !opts.activate(sessionId)) {
    void refreshSessions(projectId);
    return;
  }
  if (projectId !== store.getState().activeProjectId) store.activateProject(projectId);
  store.activateSession(sessionId);
  store.showSessionChat();
  const opening = openSession(sessionId);
  if (opts.precache) {
    void opening.catch((error) => {
      console.error("precache session failed", error);
      store.setUiError(friendlyError(tr("common.error"), error));
    });
  } else {
    await opening;
  }
  void refreshSessions(projectId);
}

/** Create a linked worktree on a fresh branch and return its path. Untitled
 *  sessions start with a unique codename; titled ones use the existing semantic
 *  template. `base` selects the starting ref, or the current HEAD when omitted. */
export async function createDefaultWorktree(
  projectId: string,
  title?: string,
  base?: string,
): Promise<string> {
  const [worktrees, branches] = await Promise.all([
    api.listWorktrees(projectId),
    api.gitBranches(projectId),
  ]);
  const taken = [
    ...worktrees.map((worktree) => worktree.branch).filter((branch): branch is string => !!branch),
    ...branches.branches.map((branch) => branch.name),
  ];
  const attempted: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const known = [...taken, ...attempted];
    const branch = title
      ? suggestWorktreeBranch(store.getState().settings.branchTemplate, title, known)
      : temporaryWorktreeBranch(known);
    attempted.push(branch);
    try {
      return (await api.createWorktree(
        projectId,
        branch,
        undefined,
        base || undefined,
        true,
      )).path;
    } catch (error) {
      // `newBranchOnly` makes Git the final collision authority. Another
      // device may win after our list call; choose a different codename.
      if (errorCodeOf(error) !== "conflict") throw error;
    }
  }
  throw Object.assign(new Error("could not allocate a unique worktree branch"), { code: "conflict" });
}

export async function createSession(projectId: string, opts: CreateSessionOptions = {}): Promise<string> {
  const { precache = false, activate, personDefaultHarnessId, ...requested } = opts;
  const input: typeof requested = personDefaultHarnessId ? withoutRoute(requested) : requested;
  const project = store.getState().projectRegistry.projects.find((candidate) => candidate.id === projectId);
  const { model, agent } = personDefaultHarnessId ? {} : compatibleCreationDefaults(project, opts);
  if (
    !opts.worktreePath
    && project?.defaults?.worktreeBehavior === "fresh-worktree"
    && projectIsolationLevel(project.defaults) !== "off"
  ) {
    return startIsolatedSession(projectId, {
      ...(opts.harness ? { harness: opts.harness } : {}),
      ...(opts.repositoryIds ? { repositoryIds: opts.repositoryIds } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
      ...(personDefaultHarnessId ? { personDefaultHarnessId } : {}),
      precache,
      ...(activate ? { activate } : {}),
    });
  }
  const worktreePath = opts.worktreePath;
  let sessionId: string;
  try {
    // Keyed: a lost response (phone on Polyth Link) resolves to the session the
    // request made instead of an "outcome unknown" or a duplicate on resend.
    ({ id: sessionId } = await createSessionWithRecovery({
      create: (clientOperationId) => api.createSession({
        projectId,
        ...input,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
        ...(worktreePath ? { worktreePath } : {}),
        clientOperationId,
      }),
      status: (clientOperationId) => api.sessionCreateOperation(clientOperationId),
    }));
  } catch (error) {
    cleanupFailedStartupSessionFromError(error);
    throw error;
  }
  await publishCreatedSession({
    id: sessionId,
    projectId,
    title: input.title ?? "",
    ...(input.harness ? { harness: input.harness } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  }, { precache, activate });
  return sessionId;
}

export async function forkSession(sessionId: string, atSeq?: number): Promise<void> {
  // The child id only exists once the server answers, so the chat area enters
  // its loading layer at once under a placeholder claim. A navigation made
  // while the fork is in flight wins: the child is created but not opened.
  const claim = `fork:${sessionId}:${atSeq ?? ""}`;
  const before = store.getState();
  store.setOpeningSession(claim);
  const releaseClaim = () => {
    if (store.getState().openingSessionId === claim) store.setOpeningSession(null);
  };
  let result: Awaited<ReturnType<typeof api.fork>>;
  try {
    result = await api.fork(sessionId, atSeq);
  } catch (error) {
    releaseClaim();
    throw error;
  }
  const now = store.getState();
  const navigatedAway = now.activeSessionId !== before.activeSessionId
    || now.activeProjectId !== before.activeProjectId
    || now.newSessionIntent !== before.newSessionIntent;
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
  if (navigatedAway || store.getState().openingSessionId !== claim) {
    releaseClaim();
    if (proj) void refreshSessions(proj);
    return;
  }
  try {
    await openSession(result.id);
  } finally {
    releaseClaim();
  }
  if (proj) void refreshSessions(proj);
}

/** Run one session lifecycle request behind an optimistic store change: the
 *  row reflects the action at once and is restored when the server rejects
 *  it. The request itself is sent exactly once and never replayed. */
export async function withOptimisticSessionChange<T>(
  sessionId: string,
  change: store.OptimisticSessionChange,
  request: () => Promise<T>,
): Promise<T> {
  const proj = store.getState().sessions.find((s) => s.id === sessionId)?.projectId;
  const optimistic = store.beginOptimisticSessionChange(sessionId, change);
  try {
    const result = await request();
    optimistic.settle();
    return result;
  } catch (error) {
    optimistic.rollback();
    throw error;
  } finally {
    if (proj) void refreshSessions(proj);
  }
}

export async function archiveSession(sessionId: string): Promise<void> {
  await withOptimisticSessionChange(sessionId, { kind: "patch", patch: { status: "archived" } }, () => api.archive(sessionId));
}

export async function restoreSession(sessionId: string): Promise<void> {
  await withOptimisticSessionChange(sessionId, { kind: "patch", patch: { status: "idle" } }, () => api.restore(sessionId));
}

/** Hard delete through the guarded server path. Callers confirm destructive
 *  intent for running/pending sessions BEFORE calling this.
 *
 *  A user delete is optimistic: the row disappears and an open chat closes
 *  before the request returns; a rejection restores the row (and the chat,
 *  when the person has not moved elsewhere meanwhile) and rethrows for the
 *  caller's error notice. A guarded background delete (`expectedLastEventSeq`
 *  / `expectedUpdatedAt`) may legitimately lose its precondition, so it keeps
 *  confirm-then-remove and never flickers a row the user is looking at. */
export async function deleteSession(sessionId: string, options?: SessionDeleteOptions): Promise<void> {
  const before = store.getState();
  const proj = before.sessions.find((s) => s.id === sessionId)?.projectId;
  const guarded = options?.expectedLastEventSeq !== undefined || options?.expectedUpdatedAt !== undefined;
  if (guarded) await api.deleteSession(sessionId, options);
  // Give a mounted uncontrolled Composer a synchronous local-only flush while
  // its session id is still active. React's outgoing layout effect runs after
  // activateSession(null), which is too late for recovery to read live input.
  store.flushComposerDraftBeforeSessionRemoval(sessionId);
  if (!guarded) {
    const wasActive = before.activeSessionId === sessionId;
    const optimistic = store.beginOptimisticSessionChange(sessionId, { kind: "hide" });
    if (wasActive) store.activateSession(null);
    try {
      await api.deleteSession(sessionId, options);
      optimistic.settle();
    } catch (error) {
      optimistic.rollback();
      const now = store.getState();
      if (wasActive && now.activeSessionId === null && now.newSessionIntent === null
        && now.activeProjectId === before.activeProjectId
        && now.sessions.some((s) => s.id === sessionId)) {
        store.activateSession(sessionId);
        // Revalidate history that inactive-cache bounding may have evicted.
        void openSession(sessionId).catch(() => {});
      }
      if (proj) void refreshSessions(proj);
      throw error;
    }
  }
  store.removeSession(sessionId);
  if (store.getState().activeSessionId === sessionId) store.activateSession(null);
  if (proj) void refreshSessions(proj);
}

export interface SendOptions {
  /** Captured target; falls back to the active session when omitted. */
  targetSessionId?: string | null;
  delivery?: "normal" | "steer" | "queue" | "interrupt";
  /** Atomically reject open questions / deny open permissions before admission. */
  dismissPending?: boolean;
  /** Reusable execution configuration resolved server-side. A string
   *  selects a profile, `null` explicitly clears the session's stored one,
   *  omitted inherits it. */
  agentProfileId?: string | null;
  /** Retry/regeneration of an already-visible prompt: model-visible, chat-hidden. */
  hiddenUserMessage?: boolean;
  /** Composer pills; validated + persisted server-side before the model sees them. */
  attachments?: AttachmentRef[];
  /** Exact native command selected by the composer catalog. */
  command?: { id: string; args?: string };
  /** Captured reliability namespace for async create-then-send flows. */
  reliabilityScope?: PersistenceScope;
  /** Browser-staged harness route, committed only with this submission. */
  harness?: HarnessSelection;
  /** First send in a newly-created session: remove only after a confirmed
   * startup failure whose canonical history has no assistant output. */
  deleteIfFailedToStart?: boolean;
}

/** Returns true when the server accepted the message (callers that persist
 *  pending composer configuration consume it only on success). */
export async function sendMessage(text: string, model?: JsonObject, agent?: string, opts?: SendOptions): Promise<boolean> {
  const id = opts?.targetSessionId ?? store.getState().activeSessionId;
  if (!id) return false;
  const trackFailedStartup = opts?.deleteIfFailedToStart === true
    && store.getState().settings.autoDeleteFailedStartupSessions;
  if (trackFailedStartup) trackFailedStartupCandidate(id);
  const capturedScope = opts?.reliabilityScope;
  const failureScopeKey = scopedDraftCacheKey(id, capturedScope);
  // The server records an auto title with the first admitted user message.
  // Keeping this durable prevents later projection broadcasts, refreshes, and
  // reconnects from restoring the "New session" placeholder.
  const session = store.getState().sessions.find((s) => s.id === id);
  const autoTitle = store.getState().settings.autoTitleSessions
    && !!session
    && isPlaceholderTitle(session.title, session.id);
  try {
    const delivery = opts?.delivery;
    const body = {
      text, model, agent, ...(autoTitle ? { autoTitle: true } : {}),
      ...(opts?.hiddenUserMessage ? { hiddenUserMessage: true } : {}),
      ...(opts?.command ? { command: opts.command } : {}),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts?.harness ? { harness: opts.harness } : {}),
      ...(opts?.dismissPending ? { dismissPending: true } : {}),
      // Explicit null must reach the wire (it clears the stored profile);
      // only an omitted field means "inherit".
      ...(opts?.agentProfileId !== undefined ? { agentProfileId: opts.agentProfileId } : {}),
    };
    if (!delivery || delivery === "normal" || delivery === "queue") {
      await submitDirectPrompt(id, {
        ...body,
        ...(delivery ? { delivery } : {}),
      }, capturedScope);
    } else {
      if (capturedScope && !persistenceScopeIsCurrent(capturedScope)) {
        throw Object.assign(new Error("session context changed before admission"), {
          code: "client-context-changed",
          status: 409,
        });
      }
      await api.sendMessage(id, { ...body, delivery });
    }
    clearSendFailure(id, failureScopeKey);
    return true;
  } catch (err) {
    console.error("send message failed", err);
    const failure = reportSendFailure(id, err, failureScopeKey);
    const errorCode = errorCodeOf(err);
    if (isStaleModelRefusal(errorCode)) refreshStaleModelCatalog();
    // An early cancel is the user's own Stop winning the preparation race. The
    // composer gets its text back below; an error banner would contradict that.
    if (errorCode !== "turn-cancelled" && failure?.kind !== "unknown") {
      store.setUiError(friendlyError(tr("common.error"), err));
    }
    const status = typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : 0;
    // A retryable HTTP response can still accompany a durable turn/failed
    // event. Ask the canonical store to verify both facts instead of treating
    // the transport classification as the deletion decision.
    const shouldVerifyStartupFailure = trackFailedStartup
      && errorCode !== "outcome-unknown"
      && (failure === null || status >= 500);
    if (shouldVerifyStartupFailure) cleanupFailedStartupCandidate(id);
    else if (trackFailedStartup && (status !== 0 || errorCode === "outcome-unknown")) {
      clearFailedStartupCandidate(id);
    }
    return false;
  }
}

export async function abortSession(source = "composer"): Promise<void> {
  const id = store.getState().activeSessionId;
  if (!id) return;
  try {
    await api.abort(id, source);
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

/** Rate-limit wait: compact the native context before the resend runs. */
export async function setResumeCompact(sessionId: string, compact: boolean): Promise<void> {
  try {
    await api.setResumeCompact(sessionId, compact);
  } catch (err) {
    console.error("set resume compaction failed", err);
    store.setUiError(friendlyError(tr("common.error"), err));
  }
}

/** Rate-limit wait: resend the last message now on an optional model/route. */
export async function resumeNow(sessionId: string, options?: ResumeTurnOptions): Promise<void> {
  try {
    await api.resumeNow(sessionId, options);
  } catch (err) {
    console.error("resume now failed", err);
    store.setUiError(friendlyError(tr("common.error"), err));
  }
}

/** Pause a chat's running turn; Continue (or Stop) ends the pause. Resolves
 *  false when it failed. */
export async function pauseSession(sessionId: string, source: string): Promise<boolean> {
  try {
    await api.pause(sessionId, source);
    return true;
  } catch (err) {
    console.error("pause failed", err);
    store.setUiError(friendlyError(tr("subagentdock.pause"), err));
    return false;
  }
}

/** Continue a paused chat on the same history. Resolves false when it failed. */
export async function continuePausedSession(sessionId: string, source: string): Promise<boolean> {
  try {
    await api.continuePaused(sessionId, source);
    return true;
  } catch (err) {
    console.error("continue failed", err);
    store.setUiError(friendlyError(tr("subagentdock.continue"), err));
    return false;
  }
}

/** Interactive replies MUST target the originating session — never live
 *  `activeSessionId`, which can change after the user opened the card. */
export function replyPermission(
  sessionId: string,
  requestId: string,
  reply: "once" | "always" | "reject",
  scope?: "session" | "project",
): void {
  void api.replyPermission(sessionId, requestId, reply, scope).catch((err) => console.error("permission reply failed", err));
}

export function answerQuestion(sessionId: string, requestId: string, answers: JsonObject): void {
  void api.answerQuestion(sessionId, requestId, answers).catch((err) => console.error("question reply failed", err));
}

export function rejectQuestion(sessionId: string, requestId: string): void {
  void api.rejectQuestion(sessionId, requestId).catch((err) => console.error("question reject failed", err));
}

export async function replySecret(
  sessionId: string,
  requestId: string,
  action: "save" | "dismiss",
  value?: string,
): Promise<void> {
  try {
    await api.replySecret(sessionId, requestId, action, value);
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
