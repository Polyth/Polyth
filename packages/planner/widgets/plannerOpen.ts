// "Open in Planner" from a chat: the pane opens (or is already open) and
// shows that task's page. The request waits here until the pane takes it.
import type { Unregister, WebPackageHost } from "@polyth/web-sdk";
import { PLANNER_PACKAGE_ID } from "../src/packageId.ts";

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Hand the Planner pane one task to show. */
export function requestPlannerTask(taskId: string): void {
  pending = taskId;
  for (const listener of listeners) listener();
}

/** The pane takes the request once; later readers see nothing. */
export function takePlannerTaskRequest(): string | null {
  const taskId = pending;
  pending = null;
  return taskId;
}

export function subscribePlannerTaskRequests(listener: () => void): Unregister {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function openPlannerTask(host: WebPackageHost, taskId: string): void {
  requestPlannerTask(taskId);
  host.navigation.openWorkspacePane(PLANNER_PACKAGE_ID);
}
