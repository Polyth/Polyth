// UX-PERSONAS: built-in capability descriptors. This module attaches open
// commands and availability checks to the pure navigation metadata in
// capabilities.ts and registers everything once on import (like
// railSurfaces.tsx). Rendering ownership stays with the existing workspace
// and right-surface registries — descriptors here are navigation only.
import {
  BUILTIN_CAPABILITY_META, registerCapability, type CapabilityMeta,
} from "./capabilities.ts";
import {
  openSettingsPage, openWorkspacePane, setActiveView, setRailPlugin, setSidebarOpen, type AppView,
} from "./store.ts";
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

function openOf(meta: CapabilityMeta): () => void {
  const view = VIEW_OF_CAPABILITY[meta.id];
  if (view) {
    return () => {
      // Primary destinations must become the visible workspace, not merely
      // update underneath a pane, compact rail sheet, or sidebar drawer.
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
