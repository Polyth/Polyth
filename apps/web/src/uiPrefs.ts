// Local UI settings (Settings overlay pages). All persisted in localStorage
// under polyth.settings; visual prefs apply as data attributes on <body> so
// CSS picks them up without component churn.
import { useSyncExternalStore } from "react";

export interface UiSettings {
  density: "comfortable" | "compact";
  fontSize: "s" | "m" | "l";
  chatWidth: "normal" | "wide";
  reducedMotion: boolean;
  /** Browser notification when a turn finishes in a hidden tab. */
  notifyOnComplete: boolean;
  /** Short beep when a turn finishes. */
  notifySound: boolean;
  confirmSessionArchive: boolean;
  autoScroll: boolean;
  /** MCP server entries (stored locally; runtime integration pending). */
  mcpServers: Array<{ name: string; url: string }>;
}

export const UI_SETTINGS_KEY = "polyth.settings";

export const UI_DEFAULTS: UiSettings = {
  density: "comfortable",
  fontSize: "m",
  chatWidth: "normal",
  reducedMotion: false,
  notifyOnComplete: false,
  notifySound: false,
  confirmSessionArchive: false,
  autoScroll: true,
  mcpServers: [],
};

export function parseUiSettings(raw: string | null): UiSettings {
  const d = { ...UI_DEFAULTS, mcpServers: [] as UiSettings["mcpServers"] };
  try {
    const data = JSON.parse(raw ?? "") as Partial<UiSettings>;
    return {
      density: data.density === "compact" ? "compact" : "comfortable",
      fontSize: data.fontSize === "s" || data.fontSize === "l" ? data.fontSize : "m",
      chatWidth: data.chatWidth === "wide" ? "wide" : "normal",
      reducedMotion: data.reducedMotion === true,
      notifyOnComplete: data.notifyOnComplete === true,
      notifySound: data.notifySound === true,
      confirmSessionArchive: data.confirmSessionArchive === true,
      autoScroll: data.autoScroll !== false,
      mcpServers: Array.isArray(data.mcpServers)
        ? data.mcpServers
            .filter((s): s is { name: string; url: string } => !!s && typeof s.name === "string" && typeof s.url === "string")
            .slice(0, 32)
        : [],
    };
  } catch {
    return d;
  }
}

const read = (): string | null => {
  try { return localStorage.getItem(UI_SETTINGS_KEY); } catch { return null; }
};
const write = (v: string): void => {
  try { localStorage.setItem(UI_SETTINGS_KEY, v); } catch { /* private mode */ }
};

let settings: UiSettings = parseUiSettings(read());
const listeners = new Set<() => void>();

/** Reflect visual prefs onto <body> data attributes (CSS reads them). */
export function applyUiSettings(s: UiSettings = settings): void {
  if (typeof document === "undefined") return;
  const b = document.body;
  b.dataset.density = s.density;
  b.dataset.fontsize = s.fontSize;
  b.dataset.chatwidth = s.chatWidth;
  b.dataset.motion = s.reducedMotion ? "reduced" : "full";
}

export function getUiSettings(): UiSettings {
  return settings;
}

export function setUiSettings(patch: Partial<UiSettings>): void {
  settings = { ...settings, ...patch };
  write(JSON.stringify(settings));
  applyUiSettings(settings);
  for (const l of [...listeners]) l();
}

export function useUiSettings(): UiSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getUiSettings,
  );
}
