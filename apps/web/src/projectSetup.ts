import { useSyncExternalStore } from "react";
import { getState, subscribeStore } from "./store.ts";

export type ProjectSetupState = "unseen" | "completed";

export const PROJECT_SETUP_KEY = "polyth.projectSetup.v1";
export const projectSetupStorageKey = (projectId: string): string =>
  `${PROJECT_SETUP_KEY}.${projectId}`;

function read(projectId: string | null): ProjectSetupState {
  if (projectId === null) return "completed";
  try {
    return localStorage.getItem(projectSetupStorageKey(projectId)) === "completed"
      ? "completed"
      : "unseen";
  } catch {
    return "unseen";
  }
}

let activeProjectId = getState().activeProjectId;
let state = read(activeProjectId);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

subscribeStore(() => {
  const nextProjectId = getState().activeProjectId;
  if (nextProjectId === activeProjectId) return;
  activeProjectId = nextProjectId;
  state = read(activeProjectId);
  emit();
});

export function getProjectSetupState(): ProjectSetupState {
  return state;
}

export function completeProjectSetup(): void {
  if (activeProjectId === null || state === "completed") return;
  try {
    localStorage.setItem(projectSetupStorageKey(activeProjectId), "completed");
  } catch {
    // Completing setup still dismisses it for this document without storage.
  }
  state = "completed";
  emit();
}

export function subscribeProjectSetup(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useProjectSetupState(): ProjectSetupState {
  return useSyncExternalStore(subscribeProjectSetup, getProjectSetupState);
}
