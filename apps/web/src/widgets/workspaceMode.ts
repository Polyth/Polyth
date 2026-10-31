import { useSyncExternalStore } from "react";
import {
  markProjectPresentationChanged,
  PROJECT_PRESENTATION_HYDRATED_EVENT,
  projectPresentationEventHasKey,
  projectPresentationEventProjectId,
} from "../projectPresentationSync.ts";
import { presentationScopeId, sharesPresentationScope } from "../projectInterfaceScope.ts";

export type WorkspaceMode = "chat" | "widgets" | "edit";
export type WorkspaceContentMode = "chat" | "widgets";

export const WORKSPACE_MODE_KEY = "polyth.workspaceMode.v1";
export const workspaceModeStorageKey = (projectId: string): string =>
  `${WORKSPACE_MODE_KEY}.${projectId}`;

const WORKSPACE_EDITING_KEY = "polyth.workspaceEditing.v1";
const workspaceEditingStorageKey = (projectId: string): string =>
  `${WORKSPACE_EDITING_KEY}.${projectId}`;
const WORKSPACE_EDIT_RETURN_KEY = "polyth.workspaceEditReturnMode.v1";
const workspaceEditReturnStorageKey = (projectId: string): string =>
  `${WORKSPACE_EDIT_RETURN_KEY}.${projectId}`;

/** Canvas is opt-in. The project decides whether the Canvas tab is offered at
 * all; which of Chat/Canvas a project is currently showing stays device-local
 * with the rest of the workspace navigation state. */
export const WORKSPACE_CANVAS_KEY = "polyth.canvasEnabled.v1";
export const workspaceCanvasStorageKey = (projectId: string): string =>
  `${WORKSPACE_CANVAS_KEY}.${presentationScopeId(projectId)}`;

interface WorkspacePresentation {
  contentMode: WorkspaceContentMode;
  editing: boolean;
  canvasEnabled: boolean;
}

function readStoredMode(projectId: string | null): WorkspaceMode {
  if (projectId === null) return "chat";
  try {
    const stored = localStorage.getItem(workspaceModeStorageKey(projectId));
    if (stored === "widgets" || stored === "edit") return stored;
    if (stored !== null) {
      const parsed = JSON.parse(stored) as unknown;
      if (parsed === "widgets" || parsed === "edit") return parsed;
    }
  } catch { /* private mode */ }
  return "chat";
}

function readLegacyEditReturnMode(projectId: string | null): WorkspaceContentMode {
  if (projectId === null) return "chat";
  try {
    return localStorage.getItem(workspaceEditReturnStorageKey(projectId)) === "widgets"
      ? "widgets"
      : "chat";
  } catch { return "chat"; }
}

function readLocalEditing(projectId: string | null): boolean | null {
  if (projectId === null) return null;
  try {
    const stored = localStorage.getItem(workspaceEditingStorageKey(projectId));
    return stored === "true" ? true : stored === "false" ? false : null;
  } catch { return null; }
}

function readCanvasEnabled(projectId: string | null): boolean {
  if (projectId === null) return false;
  try { return localStorage.getItem(workspaceCanvasStorageKey(projectId)) === "true"; }
  catch { return false; }
}

function load(projectId: string | null): WorkspacePresentation {
  const storedMode = readStoredMode(projectId);
  return {
    contentMode: storedMode === "edit" ? readLegacyEditReturnMode(projectId) : storedMode,
    // Older builds synchronized `edit` as a workspace mode. Honor that value
    // until this device has made an explicit choice using the local edit key.
    editing: readLocalEditing(projectId) ?? storedMode === "edit",
    canvasEnabled: readCanvasEnabled(projectId),
  };
}

let projectId: string | null = null;
let { contentMode, editing, canvasEnabled } = load(projectId);
const listeners = new Set<() => void>();

export function getWorkspaceMode(): WorkspaceMode {
  return editing ? "edit" : contentMode;
}

/** The selected surface is independent of the local Edit toggle. */
export function getWorkspaceContentMode(): WorkspaceContentMode {
  return contentMode;
}

export function useWorkspaceContentMode(): WorkspaceContentMode {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getWorkspaceContentMode,
  );
}

/** Whether this project offers the Canvas surface at all. Off unless the user
 * turned it on for the project; a device that already sits in Canvas keeps the
 * tab so it can switch back out. */
export function getWorkspaceCanvasEnabled(): boolean {
  return canvasEnabled;
}

export function useWorkspaceCanvasEnabled(): boolean {
  return useSyncExternalStore(
    subscribeWorkspaceCanvasEnabled,
    getWorkspaceCanvasEnabled,
  );
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Project-scoped read, for surfaces that configure a project other than the
 * active one. Never touches module state. */
export function workspaceCanvasEnabledForProject(targetProjectId: string): boolean {
  return readCanvasEnabled(targetProjectId);
}

export function subscribeWorkspaceCanvasEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Offer (or withdraw) Canvas for one project. Withdrawing while that project
 * is the active one and this device shows Canvas returns it to Chat rather than
 * stranding it behind a tab the user can no longer reach. */
export function setWorkspaceCanvasEnabledForProject(targetProjectId: string, enabled: boolean): void {
  if (readCanvasEnabled(targetProjectId) === enabled) return;
  try { localStorage.setItem(workspaceCanvasStorageKey(targetProjectId), String(enabled)); }
  catch { /* private mode */ }
  // A project choice, not device navigation, so it travels with the project.
  markProjectPresentationChanged(targetProjectId, "canvasEnabled");
  if (!sharesPresentationScope(targetProjectId, projectId)) {
    // Only this project's own presentation state is meaningful off-project.
    notify();
    return;
  }
  applyCanvasEnabled(enabled);
}

/** Offer (or withdraw) Canvas for the active project. */
export function setWorkspaceCanvasEnabled(enabled: boolean): void {
  if (canvasEnabled === enabled) return;
  if (projectId !== null) setWorkspaceCanvasEnabledForProject(projectId, enabled);
  else applyCanvasEnabled(enabled);
}

function applyCanvasEnabled(enabled: boolean): void {
  if (canvasEnabled === enabled) return;
  canvasEnabled = enabled;
  if (!enabled && contentMode === "widgets") {
    contentMode = "chat";
    editing = false;
    if (projectId !== null) {
      try {
        localStorage.setItem(workspaceModeStorageKey(projectId), "chat");
        localStorage.setItem(workspaceEditingStorageKey(projectId), "false");
      } catch { /* private mode */ }
      markProjectPresentationChanged(projectId, "workspaceMode");
    }
  }
  notify();
}

export function setWorkspaceMode(next: WorkspaceMode): void {
  if (next === "edit") {
    setWorkspaceEditing(true);
    return;
  }
  // Entering Canvas from any control (menu, hotkey, restored session) is an
  // explicit choice, so the project offers Canvas from then on.
  if (next === "widgets") setWorkspaceCanvasEnabled(true);
  if (next === contentMode && !editing) return;
  contentMode = next;
  editing = false;
  if (projectId !== null) {
    try {
      // Chat/Canvas and Edit are device-local navigation/customization state.
      localStorage.setItem(workspaceModeStorageKey(projectId), contentMode);
      localStorage.setItem(workspaceEditingStorageKey(projectId), "false");
    } catch { /* private mode */ }
    markProjectPresentationChanged(projectId, "workspaceMode");
  }
  notify();
}

export function setWorkspaceEditing(enabled: boolean): void {
  if (!enabled) {
    if (editing) setWorkspaceMode(contentMode);
    return;
  }
  if (editing) return;
  editing = true;
  if (projectId !== null) {
    try { localStorage.setItem(workspaceEditingStorageKey(projectId), "true"); }
    catch { /* private mode */ }
  }
  notify();
}

export function setWorkspaceModeProject(nextProjectId: string | null): void {
  if (nextProjectId === projectId) return;
  projectId = nextProjectId;
  ({ contentMode, editing, canvasEnabled } = load(projectId));
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener(PROJECT_PRESENTATION_HYDRATED_EVENT, (event) => {
    const hydratedProjectId = projectPresentationEventProjectId(event);
    if (hydratedProjectId === null || hydratedProjectId !== projectId) return;
    const workspaceModeChanged = projectPresentationEventHasKey(event, "workspaceMode");
    const canvasChanged = projectPresentationEventHasKey(event, "canvasEnabled");
    if (!workspaceModeChanged && !canvasChanged) return;
    ({ contentMode, editing, canvasEnabled } = load(projectId));
    notify();
  });
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
