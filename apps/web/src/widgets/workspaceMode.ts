import { useSyncExternalStore } from "react";

export type WorkspaceMode = "chat" | "widgets" | "edit";

export const WORKSPACE_MODE_KEY = "polyth.workspaceMode.v1";
export const workspaceModeStorageKey = (projectId: string): string =>
  `${WORKSPACE_MODE_KEY}.${projectId}`;

function load(projectId: string | null): WorkspaceMode {
  if (projectId === null) return "chat";
  try {
    const stored = localStorage.getItem(workspaceModeStorageKey(projectId));
    return stored === "widgets" || stored === "edit" ? stored : "chat";
  }
  catch { return "chat"; }
}

let projectId: string | null = null;
let mode = load(projectId);
const listeners = new Set<() => void>();

export function getWorkspaceMode(): WorkspaceMode {
  return mode;
}

export function setWorkspaceMode(next: WorkspaceMode): void {
  if (next === mode) return;
  mode = next;
  if (projectId !== null) {
    try { localStorage.setItem(workspaceModeStorageKey(projectId), mode); } catch { /* private mode */ }
  }
  for (const listener of [...listeners]) listener();
}

export function setWorkspaceModeProject(nextProjectId: string | null): void {
  if (nextProjectId === projectId) return;
  projectId = nextProjectId;
  mode = load(projectId);
  for (const listener of [...listeners]) listener();
}

export function useWorkspaceMode(): WorkspaceMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getWorkspaceMode,
  );
}
