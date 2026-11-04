// The browser's copy of this Space's planned tasks: one snapshot the Planner
// pane and every chat's schedule line read. Refreshed after a change made
// here, when an agent's planner call or a planned run lands in a chat, when
// the window comes back, and on a slow timer while something shows it.
import { useSyncExternalStore } from "react";
import type { Unregister, WebPackageHost } from "@polyth/web-sdk";
import type { PlannerTask } from "../src/model.ts";
import { plannerScheduleWatch } from "../src/chatSchedule.ts";
import { plannerApi } from "./plannerApi.ts";

const POLL_MS = 60_000;

export interface PlannerTasksState {
  /** `null` until the first answer. */
  tasks: readonly PlannerTask[] | null;
  error: unknown;
}

let state: PlannerTasksState = { tasks: null, error: null };
const listeners = new Set<() => void>();
let inflight: Promise<readonly PlannerTask[]> | null = null;
let stale = false;
let readAt = 0;

const emit = () => { for (const listener of listeners) listener(); };

/** Read the list again. Calls during a read join it, and only the newest
 *  answer is published: a read that started before a change never replaces
 *  the state after it. Rejects with the error when the newest read failed. */
export function refreshPlannerTasks(): Promise<readonly PlannerTask[]> {
  if (inflight) {
    stale = true;
    return inflight;
  }
  const read = async (): Promise<readonly PlannerTask[]> => {
    for (;;) {
      stale = false;
      try {
        const tasks = await plannerApi.list();
        if (stale) continue;
        state = { tasks, error: null };
        readAt = Date.now();
        emit();
        return tasks;
      } catch (error) {
        if (stale) continue;
        state = { ...state, error };
        emit();
        throw error;
      }
    }
  };
  inflight = read().finally(() => { inflight = null; });
  return inflight;
}

/** Fire-and-forget refresh: a failure stays in the state, never unhandled. */
export const requestPlannerRefresh = (): void => { void refreshPlannerTasks().catch(() => {}); };

/** Refresh unless an answer younger than `maxAgeMs` is already here (a chat
 *  being opened). */
export function ensurePlannerTasks(maxAgeMs = 15_000): void {
  if (state.tasks !== null && !state.error && Date.now() - readAt < maxAgeMs) return;
  requestPlannerRefresh();
}

/** A change confirmed by the server for one task (pause, resume, run):
 *  shown at once; `removed` drops it. A read already under way is marked
 *  stale so its older answer cannot bring the previous state back. */
export function acceptPlannerTask(task: PlannerTask, removed = false): void {
  if (!state.tasks) return;
  const rest = state.tasks.filter((item) => item.id !== task.id);
  const tasks = removed ? rest : state.tasks.some((item) => item.id === task.id)
    ? state.tasks.map((item) => item.id === task.id ? task : item)
    : [...rest, task];
  if (inflight) stale = true;
  state = { tasks, error: null };
  emit();
}

export function subscribePlannerTasks(listener: () => void): Unregister {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const plannerTasksSnapshot = (): PlannerTasksState => state;

export function usePlannerTasks(): PlannerTasksState {
  return useSyncExternalStore(subscribePlannerTasks, plannerTasksSnapshot, plannerTasksSnapshot);
}

/** Keep the snapshot current while the package is active. The slow timer
 *  only reads while a view subscribes and the page is visible. */
export function connectPlannerTasks(host: WebPackageHost): Unregister {
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const onVisible = () => { if (visible() && listeners.size > 0) requestPlannerRefresh(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(() => { if (visible() && listeners.size > 0) requestPlannerRefresh(); }, POLL_MS);
  const changed = plannerScheduleWatch();
  const offEvents = host.sessions.subscribeEvents((event) => { if (changed(event)) requestPlannerRefresh(); });
  return () => {
    clearInterval(timer);
    offEvents();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Tests: forget everything this module learned. */
export function resetPlannerTasksForTest(): void {
  state = { tasks: null, error: null };
  inflight = null;
  stale = false;
  readAt = 0;
  listeners.clear();
}
