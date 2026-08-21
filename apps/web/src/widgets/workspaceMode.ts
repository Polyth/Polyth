import { useSyncExternalStore } from "react";

export type WorkspaceMode = "chat" | "widgets";

export const WORKSPACE_MODE_KEY = "polyth.workspaceMode";

function load(): WorkspaceMode {
  try { return localStorage.getItem(WORKSPACE_MODE_KEY) === "widgets" ? "widgets" : "chat"; }
  catch { return "chat"; }
}

let mode = load();
const listeners = new Set<() => void>();

export function getWorkspaceMode(): WorkspaceMode {
  return mode;
}

export function setWorkspaceMode(next: WorkspaceMode): void {
  if (next === mode) return;
  mode = next;
  try { localStorage.setItem(WORKSPACE_MODE_KEY, mode); } catch { /* private mode */ }
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
