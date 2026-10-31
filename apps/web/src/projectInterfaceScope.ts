// Whether the customizable shell — rail buttons, header view tabs, widgets,
// the Canvas/profile offers and the phone Workspace panel — is one arrangement
// shared by every project or a separate one per project.
//
// This is a personal account preference (synced with the other UI
// preferences). It only decides which local record the presentation stores
// read and write: a project's own server record is left untouched, so other
// Space members and switching back to "per-project" keep each project's
// arrangement exactly as it was. It never changes packages or permissions.
import { useSyncExternalStore } from "react";

export type ProjectInterfaceMode = "per-project" | "shared";

export const PROJECT_INTERFACE_PREFERENCE_ID = "core.project-interface";
/** Storage scope standing in for every project while the interface is shared.
 * Canonical project ids never contain "@", so it cannot name a real project. */
export const SHARED_PRESENTATION_SCOPE = "@all-projects";

const STORAGE_KEY = "polyth.projectInterface.v1";
const DEFAULT_MODE: ProjectInterfaceMode = "per-project";
const listeners = new Set<() => void>();

export function parseProjectInterfaceMode(value: unknown): ProjectInterfaceMode {
  const mode = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { mode?: unknown }).mode
    : value;
  return mode === "shared" ? "shared" : DEFAULT_MODE;
}

function readStored(): ProjectInterfaceMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_MODE : parseProjectInterfaceMode(JSON.parse(raw));
  } catch {
    return DEFAULT_MODE;
  }
}

let mode: ProjectInterfaceMode = readStored();

export function getProjectInterfaceMode(): ProjectInterfaceMode {
  return mode;
}

export function isSharedProjectInterface(): boolean {
  return mode === "shared";
}

/** Low-level switch. Settings uses `chooseProjectInterface` (presentation
 * sync), which first seeds an empty shared record from the current project. */
export function setProjectInterfaceMode(next: ProjectInterfaceMode): void {
  const parsed = parseProjectInterfaceMode(next);
  if (parsed === mode) return;
  mode = parsed;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode })); }
  catch { /* private mode: the choice lasts for this document */ }
  for (const listener of [...listeners]) listener();
}

export function subscribeProjectInterfaceMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useProjectInterfaceMode(): ProjectInterfaceMode {
  return useSyncExternalStore(subscribeProjectInterfaceMode, getProjectInterfaceMode);
}

/** The local storage scope `projectId`'s presentation records live under. */
export function presentationScopeId(projectId: string): string {
  return mode === "shared" ? SHARED_PRESENTATION_SCOPE : projectId;
}

/** Do two projects currently show the same presentation records? */
export function sharesPresentationScope(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && presentationScopeId(a) === presentationScopeId(b);
}

/** Account preference adapter (see settingsSync `registerUiPreference`). */
export const projectInterfacePreference = {
  read: (): { mode: ProjectInterfaceMode } => ({ mode }),
  write: (value: unknown): void => setProjectInterfaceMode(parseProjectInterfaceMode(value)),
  subscribe: subscribeProjectInterfaceMode,
};

/** Test seam only. */
export function resetProjectInterfaceModeForTest(next: ProjectInterfaceMode = DEFAULT_MODE): void {
  mode = next;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* unavailable */ }
}
