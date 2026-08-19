// Minimal useSyncExternalStore-backed store. Events are kept per session;
// render models (incl. pendingPermissions/pendingQuestions) derive from them.
import { useMemo, useSyncExternalStore } from "react";
import type {
  AgentDescriptor,
  ModelDescriptor,
  Project,
  SessionEvent,
  SessionProjection,
} from "@polyth/contracts";
import { buildModel, type RenderModel } from "./reduce.ts";

export type AppView = "session" | "goals" | "multirun" | "fusion" | "walkthrough" | "preview" | "git" | "terminal";

export interface AppState {
  projects: Project[];
  sessions: SessionProjection[];
  events: Record<string, SessionEvent[]>;
  models: ModelDescriptor[];
  agents: AgentDescriptor[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeView: AppView;
  gitBranch: string;
}

let state: AppState = {
  projects: [],
  sessions: [],
  events: {},
  models: [],
  agents: [],
  activeProjectId: null,
  activeSessionId: null,
  activeView: "session",
  gitBranch: "",
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function subscribeStore(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l();
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribeStore, () => selector(getState()));
}

const EMPTY_EVENTS: SessionEvent[] = [];

export function useActiveModel(): RenderModel {
  const events = useStore((s) => (s.activeSessionId ? s.events[s.activeSessionId] : undefined) ?? EMPTY_EVENTS);
  return useMemo(() => buildModel(events), [events]);
}

// ---- actions -------------------------------------------------------------

export function setProjects(projects: Project[]): void {
  set({ projects });
}
export function setSessions(sessions: SessionProjection[]): void {
  set({ sessions });
}
export function setModels(models: ModelDescriptor[]): void {
  set({ models });
}
export function setAgents(agents: AgentDescriptor[]): void {
  set({ agents });
}
export function activateProject(id: string | null): void {
  localStorage.setItem("polyth.activeProjectId", id ?? "");
  set({ activeProjectId: id, activeSessionId: null, gitBranch: "" });
}
export function setActiveView(view: AppView): void {
  set({ activeView: view });
}
export function setGitBranch(branch: string): void {
  set({ gitBranch: branch });
}
export function activateSession(id: string | null): void {
  localStorage.setItem("polyth.activeSessionId", id ?? "");
  set({ activeSessionId: id });
}

export function upsertSession(p: SessionProjection): void {
  const i = state.sessions.findIndex((s) => s.id === p.id);
  const sessions = i >= 0 ? state.sessions.map((s, j) => (j === i ? p : s)) : [...state.sessions, p];
  set({ sessions });
}

// Dedupes by (sessionId, seq): WS gap-fill can re-deliver the boundary event.
export function applyEvent(ev: SessionEvent): void {
  const list = state.events[ev.sessionId];
  if (list && list.some((e) => e.seq === ev.seq)) return;
  const next = [...(list ?? []), ev].sort((a, b) => a.seq - b.seq);
  set({ events: { ...state.events, [ev.sessionId]: next } });
}

export function lastSeq(sessionId: string): number {
  const list = state.events[sessionId];
  return list && list.length > 0 ? list[list.length - 1]!.seq : 0;
}
