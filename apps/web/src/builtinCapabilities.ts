// UX-PERSONAS: built-in capability descriptors. This module attaches open
// commands and availability checks to the pure navigation metadata in
// capabilities.ts and registers everything once on import (like
// railSurfaces.tsx). Rendering ownership stays with the existing workspace
// and right-surface registries — descriptors here are navigation only.
import {
  BUILTIN_CAPABILITY_META, registerCapability, type CapabilityMeta,
} from "./capabilities.ts";
import {
  closeWorkspacePane, getState, openWorkspacePane, setActiveView, setRailPlugin, setSidebarOpen,
  type AppState, type AppView,
} from "./store.ts";
import { isWorkspaceSurface, listSurfaces } from "./surfaces.ts";
import { getWorkspaceSurface } from "./workspace/surfaceRegistry.ts";
import { setWorkspaceMode } from "./widgets/workspaceMode.ts";

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
};

type CapabilityState = Pick<AppState, "activeView" | "railPlugin" | "paneFullscreen">;

/** One active-state rule for every place a capability launcher can render. */
export function isCapabilityActive(id: string, current: CapabilityState = getState()): boolean {
  const view = VIEW_OF_CAPABILITY[id];
  if (view) return current.activeView === view && !(view === "session" && current.paneFullscreen);
  const pane = PANE_OF_CAPABILITY[id];
  if (pane) return current.railPlugin === pane;
  const panel = PANEL_OF_CAPABILITY[id];
  if (panel) return current.railPlugin === panel;
  const railSurface = listSurfaces().find((surface) => (surface.capabilityId ?? surface.id) === id);
  if (railSurface) return current.railPlugin === railSurface.id;
  return getWorkspaceSurface(id) !== undefined
    && current.activeView === id
    && current.railPlugin === null;
}

/** Capability launchers are toggles, regardless of which rail they live in. */
export function toggleCapability(id: string, open: () => void): void {
  const current = getState();
  if (isCapabilityActive(id, current)) {
    if (current.railPlugin !== null) {
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
  if (current.railPlugin !== null) setRailPlugin(null);
  open();
}

function openOf(meta: CapabilityMeta): () => void {
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
