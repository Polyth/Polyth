// Bootstrapping + user actions: REST load, WS wiring, session lifecycle.
import { api } from "./api.ts";
import { SyncClient } from "./sync.ts";
import { buildModel } from "./reduce.ts";
import { displaySessionTitle, isPlaceholderTitle, modelToMarkdown, titleFromPrompt } from "./format.ts";
import { friendlyError } from "./settings.ts";
import { formatAppUrl, parseAppUrl } from "./router.ts";
import * as store from "./store.ts";
import { resolveActiveProjectId } from "./projectRegistry.ts";
import type { AttachmentRef, JsonObject, Project, SessionEvent } from "@polyth/contracts";
import { suggestWorktreeBranch } from "./worktreeSessions.ts";
import { installPushDeepLinks } from "./push.ts";
import { applyComposerSeed } from "./drafts.ts";
import { forkSeedKey, rewindSeedKey } from "./messageActions.ts";

let sync: SyncClient | null = null;
let lastSubSession: string | undefined;
let lastProject: string | null | undefined;
let branchFetchedFor: string | null = null;

// Branch is resolved per (project, session): a session attached to a git
// worktree reports that worktree's branch, never the primary checkout's
// (UX-FIXTURE-VISUAL P0 — header/status must derive from the resolved root).
const branchKey = (projectId: string, sessionId: string | null): string =>
  `${projectId}\0${sessionId ?? ""}`;

function fetchBranch(projectId: string, sessionId: string | null): void {
  const key = branchKey(projectId, sessionId);
  branchFetchedFor = key;
  void api.gitStatus(projectId, sessionId ?? undefined)
    .then((st) => {
      const current = store.getState();
      if (
        branchFetchedFor === key
        && current.activeProjectId === projectId
        && current.activeSessionId === sessionId
      ) {
        store.setGitBranch(st.branch);
      }
    })
    .catch(() => {
      const current = store.getState();
      if (
        branchFetchedFor === key
        && current.activeProjectId === projectId
        && current.activeSessionId === sessionId
      ) {
        store.setGitBranch("");
      }
    });
}

// ---- session URLs -----------------------------------------------------------
// The address bar always reflects the active project/session so links can be
// shared and agents can deep-link (/p/:projectId/s/:sessionId or ?session=).
let urlSyncStarted = false;

/** Align the address bar with the store. Boot uses replaceState (no junk
 *  history entry); user-driven switches push so Back works. Skips when the
 *  URL already matches — popstate navigation never double-pushes. */
function syncUrl(replace: boolean): void {
  const s = store.getState();
  const target = formatAppUrl(s.activeProjectId, s.activeSessionId);
  if (location.pathname === target && !location.search.includes("session=")) return;
  if (replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
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
  // UX-ONBOARDING boot: project, model, and agent hydration launch
  // independently and publish as soon as each settles. Awaiting a combined
  // Promise.all/allSettled before publishing any result is forbidden — a slow
  // or failed catalog request can never delay, erase, or roll back projects.
  void refreshProjects("initial");
  void refreshModels();
  void refreshAgents();
  startSync();
  // F18: notification clicks from the service worker land here when a tab
  // already exists (postMessage instead of a second window).
  installPushDeepLinks(openSession);
  store.subscribeStore(() => {
    const s = store.getState();
    if (s.activeSessionId !== lastSubSession) {
      lastSubSession = s.activeSessionId ?? undefined;
      if (sync) sync.setSubscription(s.activeSessionId ?? undefined, s.activeSessionId ? store.lastSeq(s.activeSessionId) : 0);
    }
    if (s.activeProjectId !== lastProject) {
      lastProject = s.activeProjectId;
      if (s.activeProjectId) {
        void refreshSessions(s.activeProjectId);
        fetchBranch(s.activeProjectId, s.activeSessionId);
      } else {
        branchFetchedFor = null;
        store.setGitBranch("");
      }
    } else if (s.activeProjectId && branchFetchedFor !== branchKey(s.activeProjectId, s.activeSessionId)) {
      // Session switch (worktree may differ) or an earlier fetch failed —
      // refetch once per (project, session) pair (UX-04, UX-FIXTURE-VISUAL).
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
    store.failProjectList(ticket, friendlyError("Couldn’t load projects", err));
    if (hadSnapshot) {
      // Non-blocking refresh warning; known data stays usable.
      store.setUiError(friendlyError("Couldn’t refresh the project list", err));
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
        store.setUiError("That session link couldn’t be opened — showing the project instead.");
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

async function refreshModels(): Promise<void> {
  try {
    store.setModels(await api.listModels());
  } catch (err) {
    // Project onboarding continues; the composer catalog owns its own state.
    console.error("list models failed", err);
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
  // Micro-batched ingestion: a WS burst (reconnect gap-fill, fast streaming)
  // queues one browser task per message. A 0ms timer runs after every task
  // already in the queue, so the whole burst folds into a single applyEvents
  // (one store update + one render) instead of one render per event. Dropped
  // or reordered flushes are harmless — applyEvents sorts and dedupes by seq.
  let pending: SessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    flushTimer = null;
    const batch = pending;
    pending = [];
    if (batch.length > 0) store.applyEvents(batch);
  };
  sync.onEvent((msg) => {
    if (msg.type === "event") {
      pending.push(msg.event);
      flushTimer ??= setTimeout(flush, 0);
    } else if (msg.type === "projection") {
      store.upsertSession(msg.session);
    }
  });
  sync.connect(`${proto}://${location.host}/ws`);
}

// ---- session / project actions --------------------------------------------

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
  const session = await api.getSession(sessionId);
  if (session.projectId !== store.getState().activeProjectId) store.activateProject(session.projectId);
  const events = await api.getEvents(sessionId, 0);
  store.applyEvents(events); // one store update for the whole history
  maybeSeedFromReplay(sessionId);
  store.activateSession(sessionId);
  if (opts.showChat !== false) store.showSessionChat();
}

/** Replay-derived composer seeding (UX-MSG-ACTIONS): an active rewind marker
 *  or an unconsumed fork lineage marker seeds the draft at most once. Direct
 *  URL reload therefore restores the same editable draft; edited or cleared
 *  drafts are never overwritten (provenance in drafts.ts). */
function maybeSeedFromReplay(sessionId: string): void {
  const events = store.getState().events[sessionId] ?? [];
  if (events.length === 0) return;
  const model = buildModel(events);
  if (model.rewind?.draft) {
    applyComposerSeed(sessionId, rewindSeedKey(model.rewind.markerSeq), model.rewind.draft);
  } else if (model.fork?.draft && !model.fork.seedConsumed) {
    applyComposerSeed(sessionId, forkSeedKey(model.fork.fromSessionId, model.fork.sourceAtSeq), model.fork.draft);
  }
}

export async function refreshSessions(projectId: string): Promise<void> {
  try {
    store.setSessions(await api.listSessions(projectId));
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

export async function renameProject(id: string, name: string): Promise<void> {
  const updated = await api.patchProject(id, { name });
  store.applyProjectUpsert(updated);
}

export async function removeProject(id: string): Promise<void> {
  await api.deleteProject(id);
  store.applyProjectRemoved(id);
  void refreshProjects("reconcile");
}

export interface CreateSessionOptions {
  title?: string;
  model?: JsonObject;
  agent?: string;
  worktreePath?: string;
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

export async function createSession(projectId: string, opts: CreateSessionOptions = {}): Promise<void> {
  const project = store.getState().projectRegistry.projects.find((candidate) => candidate.id === projectId);
  const worktreePath = opts.worktreePath
    ?? (project?.defaults?.worktreeBehavior === "fresh-worktree"
      ? await createDefaultWorktree(projectId, opts.title)
      : undefined);
  const { id: sessionId } = await api.createSession({
    projectId,
    ...opts,
    ...(worktreePath ? { worktreePath } : {}),
  });
  await openSession(sessionId);
  void refreshSessions(projectId);
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
  // If the stored title is still a placeholder, derive one from the first
  // prompt so the sidebar/header update immediately (display-only upsert).
  const session = store.getState().sessions.find((s) => s.id === id);
  if (store.getState().settings.autoTitleSessions && session && isPlaceholderTitle(session.title, session.id)) {
    const derived = titleFromPrompt(text);
    if (derived) store.upsertSession({ ...session, title: derived, updatedAt: Date.now() });
  }
  try {
    await api.sendMessage(id, {
      text, model, agent,
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts?.delivery ? { delivery: opts.delivery } : {}),
      ...(opts?.dismissPending ? { dismissPending: true } : {}),
      // Explicit null must reach the wire (it clears the stored profile);
      // only an omitted field means "inherit".
      ...(opts?.agentProfileId !== undefined ? { agentProfileId: opts.agentProfileId } : {}),
    });
    return true;
  } catch (err) {
    console.error("send message failed", err);
    store.setUiError(friendlyError("Couldn’t send the message", err));
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

export function exportSessionMarkdown(): void {
  const s = store.getState();
  if (!s.activeSessionId) return;
  const model = buildModel(s.events[s.activeSessionId] ?? []);
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
