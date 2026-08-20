// Local UI settings (Settings overlay pages). All persisted in localStorage
// under polyth.settings; visual prefs apply as data attributes on <body> so
// CSS picks them up without component churn.
import { useSyncExternalStore } from "react";

export type FollowUpBehavior = "steer" | "queue" | "interrupt";
export type NotificationKindPref = "completed" | "failed" | "question" | "permission" | "subagent";

export interface UiSettings {
  density: "comfortable" | "compact";
  fontSize: "s" | "m" | "l";
  /** Editor/composer font size in px (WP2/WP9 font tokens). */
  editorFontSize: number;
  chatWidth: "normal" | "wide";
  reducedMotion: boolean;
  /** Browser notification when a turn finishes in a hidden tab. */
  notifyOnComplete: boolean;
  /** Short beep when a turn finishes. */
  notifySound: boolean;
  /** Notification kinds routed to the OS/browser layer (WP15). */
  notifyKinds: NotificationKindPref[];
  notifyOnlyWhenHidden: boolean;
  /** Notification body template; allowlisted vars {project} {session} {status} {preview}. */
  notifyTemplate: string;
  confirmSessionArchive: boolean;
  autoScroll: boolean;
  /** Send behavior while a turn is active (WP3). */
  followUpBehavior: FollowUpBehavior;
  /** Merged thinking display (WP4). */
  collapsibleThinkingBlocks: boolean;
  thinkingDefaultExpanded: boolean;
  /** Prompt navigator rail (WP4). */
  promptNavigator: "auto" | "on" | "off";
  /** JSON tree viewer defaults (WP4). */
  jsonTreeDefault: "tree" | "raw";
  jsonTreeDepth: number;
  /** Revision-guarded editor autosave (WP6). */
  editorAutosave: boolean;
  /** Work-status panel (WP8). */
  workStatusPanelEnabled: boolean;
  workStatusHiddenSections: string[];
  /** MCP server entries (stored locally; runtime integration pending). */
  mcpServers: Array<{ name: string; url: string }>;
}

export const UI_SETTINGS_KEY = "polyth.settings";

export const UI_DEFAULTS: UiSettings = {
  density: "comfortable",
  fontSize: "m",
  editorFontSize: 14,
  chatWidth: "normal",
  reducedMotion: false,
  notifyOnComplete: false,
  notifySound: false,
  notifyKinds: ["completed", "failed", "question", "permission"],
  notifyOnlyWhenHidden: true,
  notifyTemplate: "{session} — {status}",
  confirmSessionArchive: false,
  autoScroll: true,
  followUpBehavior: "queue",
  collapsibleThinkingBlocks: true,
  thinkingDefaultExpanded: false,
  promptNavigator: "auto",
  jsonTreeDefault: "tree",
  jsonTreeDepth: 2,
  editorAutosave: true,
  workStatusPanelEnabled: true,
  workStatusHiddenSections: [],
  mcpServers: [],
};

const NOTIFY_KINDS: NotificationKindPref[] = ["completed", "failed", "question", "permission", "subagent"];

export function parseUiSettings(raw: string | null): UiSettings {
  const d: UiSettings = { ...UI_DEFAULTS, mcpServers: [], notifyKinds: [...UI_DEFAULTS.notifyKinds], workStatusHiddenSections: [] };
  try {
    const data = JSON.parse(raw ?? "") as Partial<UiSettings>;
    const fontPx = Number(data.editorFontSize);
    return {
      density: data.density === "compact" ? "compact" : "comfortable",
      fontSize: data.fontSize === "s" || data.fontSize === "l" ? data.fontSize : "m",
      editorFontSize: Number.isFinite(fontPx) && fontPx >= 11 && fontPx <= 24 ? Math.round(fontPx) : 14,
      chatWidth: data.chatWidth === "wide" ? "wide" : "normal",
      reducedMotion: data.reducedMotion === true,
      notifyOnComplete: data.notifyOnComplete === true,
      notifySound: data.notifySound === true,
      notifyKinds: Array.isArray(data.notifyKinds)
        ? data.notifyKinds.filter((k): k is NotificationKindPref => NOTIFY_KINDS.includes(k as NotificationKindPref))
        : [...UI_DEFAULTS.notifyKinds],
      notifyOnlyWhenHidden: data.notifyOnlyWhenHidden !== false,
      notifyTemplate: typeof data.notifyTemplate === "string" && data.notifyTemplate.trim() !== ""
        ? data.notifyTemplate.slice(0, 200)
        : UI_DEFAULTS.notifyTemplate,
      confirmSessionArchive: data.confirmSessionArchive === true,
      autoScroll: data.autoScroll !== false,
      followUpBehavior: data.followUpBehavior === "steer" || data.followUpBehavior === "interrupt" ? data.followUpBehavior : "queue",
      collapsibleThinkingBlocks: data.collapsibleThinkingBlocks !== false,
      thinkingDefaultExpanded: data.thinkingDefaultExpanded === true,
      promptNavigator: data.promptNavigator === "on" || data.promptNavigator === "off" ? data.promptNavigator : "auto",
      jsonTreeDefault: data.jsonTreeDefault === "raw" ? "raw" : "tree",
      jsonTreeDepth: Number.isFinite(Number(data.jsonTreeDepth)) && Number(data.jsonTreeDepth) >= 0 ? Math.min(8, Math.round(Number(data.jsonTreeDepth))) : 2,
      editorAutosave: data.editorAutosave !== false,
      workStatusPanelEnabled: data.workStatusPanelEnabled !== false,
      workStatusHiddenSections: Array.isArray(data.workStatusHiddenSections)
        ? data.workStatusHiddenSections.filter((s): s is string => typeof s === "string").slice(0, 32)
        : [],
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
  b.style?.setProperty("--editor-font-size", `${s.editorFontSize}px`);
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

export interface EditorPrefs {
  openInPreview: boolean;
}

export const EDITOR_PREFS_KEY = "polyth.editorPrefs";
export const EDITOR_PREFS_DEFAULTS: EditorPrefs = { openInPreview: true };

export function parseEditorPrefs(raw: string | null): EditorPrefs {
  try {
    const value = JSON.parse(raw ?? "") as Partial<EditorPrefs>;
    return { openInPreview: value.openInPreview !== false };
  } catch {
    return { ...EDITOR_PREFS_DEFAULTS };
  }
}

let editorPrefs = parseEditorPrefs(
  (() => {
    try { return localStorage.getItem(EDITOR_PREFS_KEY); } catch { return null; }
  })(),
);
const editorPrefListeners = new Set<() => void>();

export function getEditorPrefs(): EditorPrefs {
  return editorPrefs;
}

export function setEditorPrefs(patch: Partial<EditorPrefs>): void {
  editorPrefs = { ...editorPrefs, ...patch };
  try { localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(editorPrefs)); } catch { /* best-effort */ }
  for (const listener of [...editorPrefListeners]) listener();
}

export function useEditorPrefs(): EditorPrefs {
  return useSyncExternalStore(
    (listener) => {
      editorPrefListeners.add(listener);
      return () => { editorPrefListeners.delete(listener); };
    },
    getEditorPrefs,
  );
}
