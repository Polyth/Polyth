// One list of agents for every view of the package: the navigator rows of
// each project, the overview and an agent's page read the same snapshot, so a
// change shows everywhere at once and only one request is in flight. Polls
// while anything is mounted — quickly while an agent works — and refreshes
// soon after an agent's own session reports a stop or a request.
import { useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api, type ScheduleLoopErrorDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import { normalizeScheduleList } from "./scheduleData.ts";
import { AGENT_SESSION_PURPOSE } from "../src/agentSession.ts";

export interface AgentsSnapshot {
  /** null until the first answer. */
  agents: readonly ScheduleTaskDto[] | null;
  loopErrors: readonly ScheduleLoopErrorDto[];
  error: string;
}

const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 4_000;
const EVENT_SETTLE_MS = 1_500;
const WATCHED_EVENTS = new Set([
  "turn/stopped", "permission/requested", "permission/resolved", "question/asked", "question/answered",
]);

let snapshot: AgentsSnapshot = { agents: null, loopErrors: [], error: "" };
const listeners = new Set<() => void>();
let generation = 0;
let holds = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let soon: ReturnType<typeof setTimeout> | null = null;
let host: WebPackageHost | null = null;
let offEvents: (() => void) | null = null;

const publish = (next: AgentsSnapshot): void => {
  snapshot = next;
  for (const listener of [...listeners]) listener();
};

const busy = (): boolean => (snapshot.agents ?? []).some((agent) => agent.history?.some((run) => run.status === "running"));

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!listeners.size) return;
  timer = setTimeout(() => { void refreshAgents(); }, busy() ? BUSY_POLL_MS : IDLE_POLL_MS);
}

/** Read the list now. Answers that started before an optimistic change are dropped. */
export async function refreshAgents(): Promise<void> {
  const ticket = ++generation;
  try {
    const list = normalizeScheduleList(await api.scheduleList());
    if (ticket !== generation || holds > 0) return;
    publish({ agents: list.tasks, loopErrors: list.loopErrors, error: "" });
  } catch (cause) {
    if (ticket !== generation) return;
    publish({ ...snapshot, error: cause instanceof Error ? cause.message : String(cause) });
  } finally {
    if (ticket === generation) schedule();
  }
}

function refreshSoon(): void {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    void refreshAgents();
  }, EVENT_SETTLE_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Nothing watched the list until now, so what it holds may be old.
  if (listeners.size === 1) void refreshAgents();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function useAgents(): AgentsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function agentsSnapshot(): AgentsSnapshot {
  return snapshot;
}

/** Show a saved agent at once (create, update, a server answer). */
export function putAgent(agent: ScheduleTaskDto): void {
  const list = snapshot.agents ?? [];
  const index = list.findIndex((item) => item.id === agent.id);
  const agents = index < 0 ? [...list, agent] : list.map((item) => item.id === agent.id ? agent : item);
  generation += 1; // an older list answer must not undo this
  publish({ ...snapshot, agents });
}

export function dropAgent(id: string): void {
  generation += 1;
  publish({ ...snapshot, agents: (snapshot.agents ?? []).filter((item) => item.id !== id) });
}

/** Apply `change` now, run `work`, and restore the previous agent if it fails.
 *  List answers meanwhile are held back so a stale one cannot undo it. */
export async function optimistic(id: string, change: Partial<ScheduleTaskDto>, work: () => Promise<ScheduleTaskDto | void>): Promise<void> {
  const before = snapshot.agents?.find((item) => item.id === id);
  if (before) putAgent({ ...before, ...change });
  holds += 1;
  try {
    const saved = await work();
    if (saved) putAgent(saved);
  } catch (cause) {
    const current = snapshot.agents?.find((item) => item.id === id);
    if (before && current) putAgent(before);
    throw cause;
  } finally {
    holds -= 1;
    void refreshAgents();
  }
}

/** Activation wiring: refresh soon after an agent's own session stops or
 *  asks for something. Returns the teardown. */
export function bindAgentsHost(next: WebPackageHost): () => void {
  host = next;
  offEvents?.();
  offEvents = next.sessions.subscribeEvents((event) => {
    if (!WATCHED_EVENTS.has(event.type) || !listeners.size) return;
    const session = host?.sessions.get(event.sessionId);
    const ownedByAgent = session?.purpose === AGENT_SESSION_PURPOSE
      || (snapshot.agents ?? []).some((agent) => agent.lastSessionId === event.sessionId
        || agent.history?.some((run) => run.sessionId === event.sessionId));
    if (ownedByAgent) refreshSoon();
  });
  const onVisible = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible" && listeners.size) void refreshAgents();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    offEvents?.();
    offEvents = null;
    host = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    if (soon) clearTimeout(soon);
    soon = null;
  };
}

// ---- opening an agent's page on a tab ------------------------------------------

/** The agent's page shows its conversation, its memory or its settings. */
export type AgentTab = "conversation" | "memory" | "settings";

let pendingPage: { agentId: string; tab?: AgentTab } | null = null;
const pageListeners = new Set<() => void>();

/** Ask the agent's page to show one tab; it takes this when it shows the agent. */
export function requestAgentPage(agentId: string, tab?: AgentTab): void {
  pendingPage = { agentId, ...(tab ? { tab } : {}) };
  for (const listener of [...pageListeners]) listener();
}

export function takeAgentPageRequest(agentId?: string): { agentId: string; tab?: AgentTab } | null {
  const request = pendingPage;
  if (!request || (agentId !== undefined && request.agentId !== agentId)) return null;
  pendingPage = null;
  return request;
}

export function onAgentPageRequest(listener: () => void): () => void {
  pageListeners.add(listener);
  return () => pageListeners.delete(listener);
}
