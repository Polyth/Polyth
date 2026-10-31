import { useEffect, useSyncExternalStore } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { tt } from "./i18n.ts";
import { api } from "./api.ts";
import {
  DEFAULT_TASK_TRACKER_PREFERENCES,
  mergePreferences,
  type TaskTrackerManagementDto,
  type TaskTrackerPreferences,
  type TaskTrackerPreferencesPatch,
} from "../src/types.ts";
import { clearTaskTrackerCache } from "./cache.ts";

/**
 * One browser-side cache of the Space's tracker settings, shared by the
 * management page, the package page, the board and the widget installer.
 */

export interface ManagementState {
  data: TaskTrackerManagementDto | null;
  loading: boolean;
  error: string;
}

let state: ManagementState = { data: null, loading: false, error: "" };
let inflight: Promise<TaskTrackerManagementDto | null> | null = null;
let host: WebPackageHost | null = null;
const listeners = new Set<() => void>();

const emit = (next: Partial<ManagementState>): void => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export const TASK_TRACKER_CHANGED = "polyth:task-tracker-changed";

export function setTaskTrackerHost(value: WebPackageHost | null): void {
  host = value;
}

export function taskTrackerHost(): WebPackageHost | null {
  return host;
}

export function friendly(action: string, cause: unknown): string {
  if (host) return host.errors.friendly(action, cause);
  return cause instanceof Error && cause.message ? `${action}: ${cause.message}` : action;
}

export function subscribeManagement(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function managementSnapshot(): ManagementState {
  return state;
}

/** Replace the cache with an authoritative server response. */
export function applyManagement(data: TaskTrackerManagementDto): void {
  emit({ data, error: "", loading: false });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TASK_TRACKER_CHANGED));
}

export function loadManagement(force = false): Promise<TaskTrackerManagementDto | null> {
  if (inflight && !force) return inflight;
  if (state.data && !force) return Promise.resolve(state.data);
  emit({ loading: true });
  const request = api.taskTrackerSettings()
    .then((data) => {
      if (inflight === request) applyManagement(data);
      return data;
    })
    .catch((cause) => {
      if (inflight === request) emit({ loading: false, error: friendly(tt("tasktrackers.board.didNotLoad"), cause) });
      return null;
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** Optimistic preference change with rollback; the server stays authoritative. */
export async function updatePreferences(patch: TaskTrackerPreferencesPatch): Promise<boolean> {
  const previous = state.data;
  if (previous) {
    emit({ data: { ...previous, preferences: mergePreferences(previous.preferences, patch) }, error: "" });
  }
  try {
    applyManagement(await api.taskTrackerUpdateSettings(patch));
    return true;
  } catch (cause) {
    emit({ data: previous, error: friendly(tt("tasktrackers.manage.couldNotSave"), cause) });
    return false;
  }
}

export function currentPreferences(): TaskTrackerPreferences {
  return state.data?.preferences ?? DEFAULT_TASK_TRACKER_PREFERENCES;
}

/** Test seam: forget cached state between isolated renders. */
export function resetManagementForTests(): void {
  inflight = null;
  state = { data: null, loading: false, error: "" };
  clearTaskTrackerCache();
}

export function useManagement(): ManagementState & { preferences: TaskTrackerPreferences } {
  const snapshot = useSyncExternalStore(subscribeManagement, managementSnapshot, managementSnapshot);
  useEffect(() => {
    if (!snapshot.data && !snapshot.loading && !snapshot.error) void loadManagement();
  }, [snapshot.data, snapshot.loading, snapshot.error]);
  return { ...snapshot, preferences: snapshot.data?.preferences ?? DEFAULT_TASK_TRACKER_PREFERENCES };
}
