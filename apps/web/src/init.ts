// Bootstrapping + user actions: REST load, WS wiring, session lifecycle.
import { api } from "./api.ts";
import { SyncClient } from "./sync.ts";
import { buildModel } from "./reduce.ts";
import { displaySessionTitle, isPlaceholderTitle, modelToMarkdown, titleFromPrompt } from "./format.ts";
import { friendlyError } from "./settings.ts";
import { formatAppUrl, parseAppUrl } from "./router.ts";
import * as store from "./store.ts";
import type { AttachmentRef, JsonObject } from "@polyth/contracts";
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
  branchFetchedFor = branchKey(projectId, sessionId);
  void api.gitStatus(projectId, sessionId ?? undefined)
    .then((st) => store.setGitBranch(st.branch))
    .catch(() => store.setGitBranch(""));
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
  void boot();
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

async function boot(): Promise<void> {
  try {
    const [projects, models, agents] = await Promise.all([
      api.listProjects(),
      api.listModels(),
      api.listAgents(),
    ]);
    store.setProjects(projects);
    store.setModels(models);
    store.setAgents(agents);

    // URL wins over localStorage: opening a shared /p/…/s/… link (or an
    // agent's/push notification's ?session=) restores exactly that session.
    const fromUrl = parseAppUrl(location.pathname, location.search);
    if (fromUrl.sessionId) {
      try {
        await openSession(fromUrl.sessionId);
        const projectId = store.getState().activeProjectId;
        if (projectId) await refreshSessions(projectId);
        startUrlSync();
        return;
      } catch (err) {
        console.warn("session from URL not found, falling back", err);
      }
    }

    const savedProject = localStorage.getItem("polyth.activeProjectId");
    const activeProject =
      projects.find((p) => p.id === fromUrl.projectId)
      ?? projects.find((p) => p.id === savedProject)
      ?? projects[0];
    if (activeProject) {
      store.activateProject(activeProject.id);
      await refreshSessions(activeProject.id);
      const savedSession = localStorage.getItem("polyth.activeSessionId");
      if (savedSession && store.getState().sessions.some((session) => session.id === savedSession)) {
        await openSession(savedSession);
      }
    }
    startUrlSync();
  } catch (err) {
    console.error("initial load failed", err);
    store.setUiError(friendlyError("Couldn’t reach the Polyth server", err));
  }
}

function startSync(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  sync = new SyncClient();
  sync.onEvent((msg) => {
    if (msg.type === "event") store.applyEvent(msg.event);
    else if (msg.type === "projection") store.upsertSession(msg.session);
  });
  sync.connect(`${proto}://${location.host}/ws`);
}

// ---- session / project actions --------------------------------------------

export async function openSession(sessionId: string): Promise<void> {
  const session = await api.getSession(sessionId);
  if (session.projectId !== store.getState().activeProjectId) store.activateProject(session.projectId);
  const events = await api.getEvents(sessionId, 0);
  for (const ev of events) store.applyEvent(ev);
  maybeSeedFromReplay(sessionId);
  store.activateSession(sessionId);
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

export async function addProject(path: string, name?: string): Promise<void> {
  const p = await api.addProject(path, name);
  const projects = store.getState().projects;
  store.setProjects(projects.some((project) => project.id === p.id) ? projects : [...projects, p]);
  store.activateProject(p.id);
}

export async function createProject(path: string, name?: string): Promise<void> {
  const p = await api.createProject(path, name);
  const projects = store.getState().projects;
  store.setProjects(projects.some((project) => project.id === p.id) ? projects : [...projects, p]);
  store.activateProject(p.id);
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
  const project = store.getState().projects.find((candidate) => candidate.id === projectId);
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
