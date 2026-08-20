// Legacy persona/plugin preference shim. The mandatory persona gate and the
// plugin allow-list were replaced by optional workspace presets
// (workspacePresets.ts) and the capability registry (capabilities.ts).
// `polyth.prefs` is read exactly once by the one-time migration in
// workspacePresets.ts; after migration no header, rail, command, shortcut,
// sidebar, composer, voice, or settings path reads persona/plugin membership
// for availability. Only compatibility exports remain while external plugin
// call sites move off them.
import { useSyncExternalStore } from "react";
import { LEGACY_PERSONA_PLUGINS } from "./workspacePresets.ts";

export type PersonaId = "engineer" | "manager" | "creator" | "blank";
export type PluginId =
  | "session" | "goals" | "files" | "git" | "preview" | "terminal"
  | "context" | "usage" | "events" | "multirun" | "fusion" | "walkthrough"
  | "schedule" | "github" | "dictation" | "knowledge";

export interface Prefs {
  persona: PersonaId | null;
  plugins: PluginId[];
}

/** Kept as legacy search keywords and slot-prop compatibility labels. */
export const PLUGIN_LABELS: Record<PluginId, string> = {
  session: "Session", goals: "Goals", files: "Files", git: "Git", preview: "Preview",
  terminal: "Terminal", context: "Context", usage: "Usage", events: "Events",
  multirun: "Multi-Run", fusion: "Fusion", walkthrough: "Walkthrough",
  schedule: "Schedule", github: "GitHub", dictation: "Dictation", knowledge: "Knowledge",
};

function isPlugin(id: unknown): id is PluginId {
  return typeof id === "string" && id in PLUGIN_LABELS;
}

/** Parse a legacy record (migration input only). Empty plugin lists fill from
 *  that persona's legacy defaults, matching the historical contract. */
export function parsePrefs(raw: string | null): Prefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<Prefs>;
    const persona = data.persona && data.persona in LEGACY_PERSONA_PLUGINS ? data.persona : null;
    const plugins = Array.isArray(data.plugins) ? data.plugins.filter(isPlugin) : [];
    return {
      persona,
      plugins: persona && plugins.length === 0
        ? (LEGACY_PERSONA_PLUGINS[persona] as PluginId[]).slice()
        : plugins,
    };
  } catch {
    return { persona: null, plugins: [] };
  }
}

const KEY = "polyth.prefs";

function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

// Frozen post-migration snapshot: external plugin pages that still receive
// `prefs` through slot props keep working, but nothing mutates this record.
const prefs: Prefs = parsePrefs(read());
const noop = (): void => {};

export function getPrefs(): Prefs { return prefs; }
export function subscribePrefs(_cb: () => void): () => void { return noop; }

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}
