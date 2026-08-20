// Workspace persona + enabled plugins. Survives reload; drives nav, rail, composer.
import { useSyncExternalStore } from "react";

export type PersonaId = "engineer" | "manager" | "creator" | "blank";
export type PluginId =
  | "session" | "goals" | "files" | "git" | "preview" | "terminal"
  | "context" | "usage" | "events" | "multirun" | "fusion" | "walkthrough"
  | "schedule" | "github" | "dictation" | "knowledge";

export interface Persona {
  id: PersonaId;
  label: string;
  blurb: string;
  tags: string[];
  plugins: PluginId[];
  composer: "full" | "simple";
}

export const PERSONAS: Record<PersonaId, Persona> = {
  engineer: {
    id: "engineer", label: "Engineer",
    blurb: "Full dev toolkit in the rail — git, terminal, live preview. Diffs and tool calls shown in full, nothing hidden.",
    tags: ["git", "terminal", "preview"],
    plugins: ["session", "files", "git", "preview", "terminal", "context", "usage", "events", "goals", "multirun", "fusion", "walkthrough", "schedule", "github", "dictation", "knowledge"],
    composer: "full",
  },
  manager: {
    id: "manager", label: "Manager",
    blurb: "Goal and cost stay in view. Plain-language risk checks instead of diffs — no git, no terminal.",
    tags: ["goals", "cost", "risk checks"],
    plugins: ["session", "files", "context", "usage", "goals", "multirun", "fusion", "walkthrough", "knowledge"],
    composer: "full",
  },
  creator: {
    id: "creator", label: "Creator",
    blurb: "Just an input and a live preview. No model names, no jargon — describe it and watch it build.",
    tags: ["preview", "plain language"],
    plugins: ["session", "preview", "files"],
    composer: "simple",
  },
  blank: {
    id: "blank", label: "Blank",
    blurb: "Start empty. Add panels and workflows as widgets whenever you need them.",
    tags: ["custom"],
    plugins: ["session", "files", "context", "usage"],
    composer: "full",
  },
};

export interface Prefs {
  persona: PersonaId | null;
  plugins: PluginId[];
}

const KEY = "polyth.prefs";
const mem = new Map<string, string>();
const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; }
  },
  set(k: string, v: string): void {
    try { localStorage.setItem(k, v); } catch { mem.set(k, v); }
  },
};

export const PLUGIN_LABELS: Record<PluginId, string> = {
  session: "Session", goals: "Goals", files: "Files", git: "Git", preview: "Preview",
  terminal: "Terminal", context: "Context", usage: "Usage", events: "Events",
  multirun: "Multi-Run", fusion: "Fusion", walkthrough: "Walkthrough",
  schedule: "Schedule", github: "GitHub", dictation: "Dictation", knowledge: "Knowledge",
};

function isPlugin(id: unknown): id is PluginId {
  return typeof id === "string" && id in PLUGIN_LABELS;
}

/** Parse stored prefs. Unknown plugin ids are dropped; empty plugin lists fill from the persona. */
export function parsePrefs(raw: string | null): Prefs {
  try {
    const data = JSON.parse(raw ?? "") as Partial<Prefs>;
    const persona = data.persona && data.persona in PERSONAS ? data.persona : null;
    const plugins = Array.isArray(data.plugins) ? data.plugins.filter(isPlugin) : [];
    return { persona, plugins: persona && plugins.length === 0 ? PERSONAS[persona].plugins.slice() : plugins };
  } catch {
    return { persona: null, plugins: [] };
  }
}

const listeners = new Set<() => void>();
let prefs: Prefs = parsePrefs(store.get(KEY));

function emit(): void {
  store.set(KEY, JSON.stringify(prefs));
  for (const l of [...listeners]) l();
}

export function getPrefs(): Prefs { return prefs; }
export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function applyPersona(id: PersonaId): void {
  prefs = { persona: id, plugins: PERSONAS[id].plugins.slice() };
  emit();
}

export function setPlugins(plugins: PluginId[]): void {
  prefs = { ...prefs, plugins: [...new Set(plugins)] };
  emit();
}

export function togglePlugin(id: PluginId): void {
  if (id === "session") return;
  const on = prefs.plugins.includes(id);
  setPlugins(on ? prefs.plugins.filter((p) => p !== id) : [...prefs.plugins, id]);
}

export function pluginOn(id: PluginId): boolean {
  return prefs.plugins.includes(id);
}

export function personaOf(): Persona | null {
  return prefs.persona ? PERSONAS[prefs.persona] : null;
}

/** True when the plugin set no longer matches the persona defaults (UX-28). */
export function isCustomized(p: Prefs = prefs): boolean {
  if (!p.persona) return false;
  const defaults = PERSONAS[p.persona].plugins;
  return p.plugins.length !== defaults.length || defaults.some((id) => !p.plugins.includes(id));
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}
