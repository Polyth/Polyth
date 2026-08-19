// Bootstrapping + user actions: REST load, WS wiring, session lifecycle.
import { api } from "./api.ts";
import { SyncClient } from "./sync.ts";
import { buildModel } from "./reduce.ts";
import { modelToMarkdown } from "./format.ts";
import * as store from "./store.ts";
import type { JsonObject } from "@polyth/contracts";

let sync: SyncClient | null = null;
let lastSubSession: string | undefined;
let lastProject: string | null | undefined;
let branchFetchedFor: string | null = null;

function fetchBranch(projectId: string): void {
  branchFetchedFor = projectId;
  void api.gitStatus(projectId).then((st) => store.setGitBranch(st.branch)).catch(() => store.setGitBranch(""));
}

export function init(): void {
  void boot();
  startSync();
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
        fetchBranch(s.activeProjectId);
      } else {
        branchFetchedFor = null;
        store.setGitBranch("");
      }
    } else if (s.activeProjectId && !s.gitBranch && branchFetchedFor !== s.activeProjectId) {
      // Project unchanged but branch missing (e.g. earlier fetch failed) — refetch once (UX-04).
      fetchBranch(s.activeProjectId);
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
    const savedProject = localStorage.getItem("polyth.activeProjectId");
    const activeProject = projects.find((p) => p.id === savedProject) ?? projects[0];
    if (activeProject) {
      store.activateProject(activeProject.id);
      await refreshSessions(activeProject.id);
      const savedSession = localStorage.getItem("polyth.activeSessionId");
      if (savedSession && store.getState().sessions.some((session) => session.id === savedSession)) {
        await openSession(savedSession);
      }
    }
  } catch (err) {
    console.error("initial load failed", err);
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
  store.activateSession(sessionId);
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

export async function createSession(projectId: string, opts?: { model?: JsonObject; agent?: string }): Promise<void> {
  const { id: sessionId } = await api.createSession({ projectId, ...opts });
  await openSession(sessionId);
  void refreshSessions(projectId);
}

export async function forkSession(sessionId: string, atSeq?: number): Promise<void> {
  const { id: newId } = await api.fork(sessionId, atSeq);
  const proj = store.getState().sessions.find((s) => s.id === sessionId)?.projectId;
  await openSession(newId);
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

export async function sendMessage(text: string, model?: JsonObject, agent?: string): Promise<void> {
  const id = store.getState().activeSessionId;
  if (!id) return;
  try {
    await api.sendMessage(id, { text, model, agent });
  } catch (err) {
    console.error("send message failed", err);
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

export function replyPermission(requestId: string, reply: "once" | "always" | "reject"): void {
  const id = store.getState().activeSessionId;
  if (!id) return;
  void api.replyPermission(id, requestId, reply).catch((err) => console.error("permission reply failed", err));
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
  const title = s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? s.activeSessionId;
  const blob = new Blob([modelToMarkdown(model)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
