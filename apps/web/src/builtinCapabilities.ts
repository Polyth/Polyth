// UX-PERSONAS: built-in capability descriptors. This module attaches open
// commands and availability checks to the pure navigation metadata in
// capabilities.ts and registers everything once on import (like
// railSurfaces.tsx). Rendering ownership stays with the existing workspace
// and right-surface registries — descriptors here are navigation only.
import {
  BUILTIN_CAPABILITY_META, registerCapability, type CapabilityMeta,
} from "./capabilities.ts";
import { openSettingsPage, setActiveView, setRailPlugin, type AppView } from "./store.ts";
import { speechSupport } from "@polyth/dictation";

/** Capability id → full workspace view, used for active-state highlighting.
 *  Panel/settings capabilities have no view and never show as "active". */
export const VIEW_OF_CAPABILITY: Partial<Record<string, AppView>> = {
  session: "session",
  files: "files",
  preview: "preview",
  goals: "goals",
  multirun: "multirun",
  fusion: "fusion",
  walkthrough: "walkthrough",
  schedule: "schedule",
  github: "github",
  git: "git",
  terminal: "terminal",
};

/** Rail surface opened by a capability (panels rather than full views). */
export const PANEL_OF_CAPABILITY: Partial<Record<string, string>> = {
  usage: "usage",
  events: "events",
  context: "context",
  knowledge: "knowledge",
};

const voiceAvailable = (): boolean => {
  try {
    const support = speechSupport(typeof window !== "undefined" ? window : undefined);
    return support.stt || support.tts;
  } catch {
    return false;
  }
};

function openOf(meta: CapabilityMeta): () => void {
  const view = VIEW_OF_CAPABILITY[meta.id];
  if (view) return () => setActiveView(view);
  const panel = PANEL_OF_CAPABILITY[meta.id];
  if (panel) return () => setRailPlugin(panel);
  if (meta.id === "models-agents") return () => openSettingsPage("models");
  if (meta.id === "diagnostics") return () => openSettingsPage("plugins");
  if (meta.id === "voice") return () => openSettingsPage("voice");
  return () => setActiveView("session");
}

for (const meta of BUILTIN_CAPABILITY_META) {
  registerCapability({
    ...meta,
    open: openOf(meta),
    // Built-in navigation is always available; a capability may be
    // unavailable only for a real runtime prerequisite, never per preset.
    available: meta.id === "voice" ? voiceAvailable : () => true,
    ...(meta.id === "voice"
      ? { unavailableReason: () => voiceAvailable() ? null : "Voice input isn’t supported in this browser." }
      : {}),
  });
}
