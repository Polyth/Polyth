// Built-in capability descriptors. This module attaches open
// commands and availability checks to the pure navigation metadata in
// capabilities.ts and registers everything once on import (like
// railSurfaces.tsx). Rendering ownership stays with the existing workspace
// and right-surface registries — descriptors here are navigation only.
import {
  BUILTIN_CAPABILITY_META, getCapability, isCommandCapability, registerCapability, type CapabilityMeta,
} from "./capabilities.ts";
import {
  closePage, closeWorkspacePane, getState, openWorkspacePane, setActiveView, setRailPlugin, setSidebarOpen,
  type AppState, type AppView,
} from "./store.ts";
import { getPage } from "./pages.ts";
import { getUiSettings } from "./uiPrefs.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import { getWorkspaceSurface } from "./workspace/surfaceRegistry.ts";
import { getWorkspaceMode, setWorkspaceEditing, setWorkspaceMode } from "./widgets/workspaceMode.ts";

/** Capability id → full workspace view, used for active-state highlighting.
 *  Panel/settings capabilities have no view and never show as "active". */
export const VIEW_OF_CAPABILITY: Partial<Record<string, AppView>> = {
  session: "session",
};

/** Canonical workspace pane opened by a capability. */
export const PANE_OF_CAPABILITY: Partial<Record<string, string>> = {};

/** Rail surface opened by a capability (panels rather than full views). */
export const PANEL_OF_CAPABILITY: Partial<Record<string, string>> = {
  events: "events",
  context: "context",
  "notification-centre": "slot:notification-centre",
};

type CapabilityState = Pick<AppState, "activeView" | "railPlugin" | "paneFullscreen"> & Partial<Pick<AppState, "activePage">>;

/** A package's page in place of Chat (an agent) belongs to its launcher. */
function pageOfCapability(id: string, current: CapabilityState): boolean {
  if (!current.activePage) return false;
  const owner = getCapability(id)?.ownerPackageId;
  return !!owner && getPage(current.activePage.pageId)?.ownerPackageId === owner;
}

/** One active-state rule for every place a capability launcher can render. */
export function isCapabilityActive(id: string, current: CapabilityState = getState()): boolean {
  if (id === "workspace-edit") return getWorkspaceMode() === "edit";
  if (isCommandCapability(getCapability(id))) return false;
  const view = VIEW_OF_CAPABILITY[id];
  if (view) return current.activeView === view && !(view === "session" && current.paneFullscreen);
  const pane = PANE_OF_CAPABILITY[id];
  if (pane) return current.railPlugin === pane;
  const panel = PANEL_OF_CAPABILITY[id];
  if (panel) return current.railPlugin === panel;
  const capability = getCapability(id);
  if (pageOfCapability(id, current)) return true;
  // A package home stays active while one of its internal pages is open.
  if (capability?.ownerPackageId === id && current.railPlugin !== null
    && listSurfaces().some((surface) => surface.id === current.railPlugin && surface.ownerPackageId === id)) return true;
  const railSurface = listSurfaces().find((surface) => (surface.capabilityId ?? surface.id) === id);
  if (railSurface) return current.railPlugin === railSurface.id;
  return getWorkspaceSurface(id) !== undefined
    && current.activeView === id
    && current.railPlugin === null;
}

/** Capability launchers are toggles, regardless of which rail they live in.
 * A command launcher only acts: the open pane stays where it is. */
export function toggleCapability(id: string, open: () => void): void {
  if (isCommandCapability(getCapability(id))) {
    open();
    return;
  }
  const current = getState();
  if (id === "workspace-edit") {
    setWorkspaceEditing(!isCapabilityActive(id, current));
    return;
  }
  if (isCapabilityActive(id, current)) {
    if (pageOfCapability(id, current)) {
      closePage();
    } else if (current.railPlugin !== null) {
      const surface = listSurfaces().find((candidate) => candidate.id === current.railPlugin);
      if (surface && isWorkspaceSurface(surface)) {
        closeWorkspacePane();
      } else {
        setRailPlugin(null);
      }
    } else if (current.activeView !== "session") {
      setActiveView("session");
    }
    return;
  }
  // With "same pinned window" on, a pinned window hands its frame to the next
  // window: no close (which would reset it to dynamic), only new content.
  if (current.railPlugin !== null && !keepsPinnedFrame(id, current)) setRailPlugin(null);
  open();
}

/** The workspace window a capability opens, when it opens one. */
function workspaceSurfaceOfCapability(id: string) {
  const surfaces = listSurfaces().filter(isWorkspaceSurface);
  return surfaces.find((surface) => (surface.capabilityId ?? surface.id) === id)
    ?? (getCapability(id)?.ownerPackageId === id ? surfaces.find((surface) => surface.id === id) : undefined);
}

function keepsPinnedFrame(id: string, current: AppState): boolean {
  const pinned = current.paneMode === "pinned"
    || (current.paneMode === "fullscreen" && current.panePreviousMode === "pinned");
  if (!getUiSettings().sharedPinnedWindow || !pinned) return false;
  const open = listSurfaces().find((surface) => surface.id === current.railPlugin);
  return open !== undefined && isWorkspaceSurface(open) && workspaceSurfaceOfCapability(id) !== undefined;
}

function openOf(meta: CapabilityMeta): () => void {
  if (meta.id === "workspace-edit") return () => setWorkspaceMode("edit");
  const view = VIEW_OF_CAPABILITY[meta.id];
  if (view) {
    return () => {
      // Primary destinations must become the visible workspace, not merely
      // update underneath a pane, compact rail sheet, or sidebar drawer.
      // Navigation owns the next focus target, so a covering workspace pane
      // must not schedule its normal composer-focus restoration: that delayed
      // restoration would reset the selected primary view back to Chat.
      closeWorkspacePane({ restoreFocus: false });
      setRailPlugin(null);
      setSidebarOpen(false);
      setWorkspaceMode("chat");
      setActiveView(view);
    };
  }
  const pane = PANE_OF_CAPABILITY[meta.id];
  if (pane) return () => openWorkspacePane(pane);
  const panel = PANEL_OF_CAPABILITY[meta.id];
  if (panel) return () => setRailPlugin(panel);
  return () => setActiveView("session");
}

for (const meta of BUILTIN_CAPABILITY_META) {
  registerCapability({
    ...meta,
    open: openOf(meta),
    // Built-in navigation is always available; a capability may be
    // unavailable only for a real runtime prerequisite, never per preset.
    available: () => true,
  });
}
