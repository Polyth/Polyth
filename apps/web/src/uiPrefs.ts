// Local UI settings (Settings overlay pages). UI preferences use a dedicated,
// versioned record; `polyth.settings` is read only as a one-time migration
// source because older builds shared it with product-level settings.
import { useSyncExternalStore } from "react";
import type { NotificationKind } from "@polyth/contracts";

export type FollowUpBehavior = "steer" | "queue" | "interrupt";
export type NotificationKindPref = NotificationKind;
export type MessageCopyFormat = "markdown" | "json";
export type HeaderMetricId = "tokens" | "messages" | "duration" | "cost";
export type ResponseActionId = "copy" | "image" | "plan" | "pin" | "session" | "multirun";
export type TopRailAlignment = "center" | "left";
export type WorkingIndicator = "pulse" | "cursor" | "cat" | "activity";

export const HEADER_METRIC_IDS: readonly HeaderMetricId[] = ["tokens", "messages", "duration", "cost"];
export const RESPONSE_ACTION_IDS: readonly ResponseActionId[] = ["copy", "image", "plan", "pin", "session", "multirun"];

/** Pick a random list item without immediately repeating the previous one. */
export function nextWorkingActivity(previous: number, count: number, random = Math.random): number {
  return count < 2 ? 0 : (previous + 1 + Math.floor(random() * (count - 1))) % count;
}

export interface UiSettings {
  density: "comfortable" | "balanced" | "compact";
  fontSize: "s" | "m" | "l";
  /** Editor/composer font size in px (WP2/WP9 font tokens). */
  editorFontSize: number;
  /** Shared corner treatment for controls, panels, and overlays. */
  rounding: "square" | "compact" | "rounded";
  chatWidth: "normal" | "wide";
  /** Browser notification when a turn finishes in a hidden tab. */
  notifyOnComplete: boolean;
  /** Short beep when a turn finishes. */
  notifySound: boolean;
  /** Notification kinds routed to the OS/browser layer (WP15). */
  notifyKinds: NotificationKindPref[];
  notifyOnlyWhenHidden: boolean;
  /** Notification body template; allowlisted vars {project} {session} {status} {preview}. */
  notifyTemplate: string;
  /** NTF-01: keep read rows visible in the notification centre. Per-browser
   *  display filter only — never disables recording or clears server data. */
  notificationCentreHistory: boolean;
  confirmSessionArchive: boolean;
  autoScroll: boolean;
  /** Send behavior while a turn is active (WP3). */
  followUpBehavior: FollowUpBehavior;
  /** Merged thinking display (WP4). */
  collapsibleThinkingBlocks: boolean;
  thinkingDefaultExpanded: boolean;
  /** Visual shown below the timeline during an active turn. */
  workingIndicator: WorkingIndicator;
  /** Prompt navigator rail (WP4). */
  promptNavigator: "auto" | "on" | "off";
  /** Hover/focus controls below user and assistant messages. */
  showMessageActions: boolean;
  /** Payload selected by the single message Copy action. */
  messageCopyFormat: MessageCopyFormat;
  /** Visible session-header metrics, in drag-configured order. */
  headerMetrics: HeaderMetricId[];
  /** Assistant-header hover actions, in drag-configured order. */
  responseActions: ResponseActionId[];
  /** Placement of the configured Chat top rail in the application header. */
  topRailAlignment: TopRailAlignment;
  /** JSON tree viewer defaults (WP4). */
  jsonTreeDefault: "tree" | "raw";
  jsonTreeDepth: number;
  /** Revision-guarded editor autosave (WP6). */
  editorAutosave: boolean;
  /** Work-status panel (WP8). */
  workStatusPanelEnabled: boolean;
  workStatusHiddenSections: string[];
  showTechnicalButtons: boolean;
  showDictate: boolean;
  /** Composer shield control visibility; the session policy remains server-owned. */
  showAutoApprove: boolean;
  /** Composer target control visibility. */
  showGoals: boolean;
  showQuickActions: boolean;
  /** MCP server entries (stored locally; runtime integration pending). */
  mcpServers: Array<{ name: string; url: string }>;
}

export const UI_SETTINGS_KEY = "polyth.uiSettings.v1";
export const LEGACY_UI_SETTINGS_KEY = "polyth.settings";

export const UI_DEFAULTS: UiSettings = {
  density: "comfortable",
  fontSize: "m",
  editorFontSize: 14,
  rounding: "compact",
  chatWidth: "normal",
  notifyOnComplete: false,
  notifySound: false,
  notifyKinds: ["completed", "failed", "question", "permission"],
  notifyOnlyWhenHidden: true,
  notifyTemplate: "{session} — {status}",
  notificationCentreHistory: true,
  confirmSessionArchive: false,
  autoScroll: true,
  followUpBehavior: "queue",
  collapsibleThinkingBlocks: true,
  thinkingDefaultExpanded: false,
  workingIndicator: "pulse",
  promptNavigator: "auto",
  showMessageActions: true,
  messageCopyFormat: "markdown",
  headerMetrics: [...HEADER_METRIC_IDS],
  responseActions: [...RESPONSE_ACTION_IDS],
  topRailAlignment: "center",
  jsonTreeDefault: "tree",
  jsonTreeDepth: 2,
  editorAutosave: true,
  workStatusPanelEnabled: true,
  workStatusHiddenSections: [],
  showTechnicalButtons: true,
  showDictate: true,
  showAutoApprove: true,
  showGoals: true,
  showQuickActions: true,
  mcpServers: [],
};

const NOTIFY_KINDS: NotificationKindPref[] = ["completed", "failed", "question", "permission", "subagent"];

function orderedIds<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...allowed];
  const seen = new Set<T>();
  return value.filter((id): id is T => {
    if (typeof id !== "string" || !allowed.includes(id as T) || seen.has(id as T)) return false;
    seen.add(id as T);
    return true;
  });
}

export function parseUiSettings(raw: string | null): UiSettings {
  const d: UiSettings = { ...UI_DEFAULTS, mcpServers: [], notifyKinds: [...UI_DEFAULTS.notifyKinds], workStatusHiddenSections: [] };
  try {
    const data = JSON.parse(raw ?? "") as Partial<UiSettings>;
    const fontPx = Number(data.editorFontSize);
    const workingIndicator = data.workingIndicator as string | undefined;
    return {
      density: data.density === "compact" || data.density === "balanced" ? data.density : "comfortable",
      fontSize: data.fontSize === "s" || data.fontSize === "l" ? data.fontSize : "m",
      editorFontSize: Number.isFinite(fontPx) && fontPx >= 11 && fontPx <= 24 ? Math.round(fontPx) : 14,
      rounding: data.rounding === "square" || data.rounding === "rounded" ? data.rounding : "compact",
      chatWidth: data.chatWidth === "wide" ? "wide" : "normal",
      notifyOnComplete: data.notifyOnComplete === true,
      notifySound: data.notifySound === true,
      notifyKinds: Array.isArray(data.notifyKinds)
        ? data.notifyKinds.filter((k): k is NotificationKindPref => NOTIFY_KINDS.includes(k as NotificationKindPref))
        : [...UI_DEFAULTS.notifyKinds],
      notifyOnlyWhenHidden: data.notifyOnlyWhenHidden !== false,
      notifyTemplate: typeof data.notifyTemplate === "string" && data.notifyTemplate.trim() !== ""
        ? data.notifyTemplate.slice(0, 200)
        : UI_DEFAULTS.notifyTemplate,
      notificationCentreHistory: data.notificationCentreHistory !== false,
      confirmSessionArchive: data.confirmSessionArchive === true,
      autoScroll: data.autoScroll !== false,
      followUpBehavior: data.followUpBehavior === "steer" || data.followUpBehavior === "interrupt" ? data.followUpBehavior : "queue",
      collapsibleThinkingBlocks: data.collapsibleThinkingBlocks !== false,
      thinkingDefaultExpanded: data.thinkingDefaultExpanded === true,
      workingIndicator: workingIndicator === "keyboard" || workingIndicator === "cursor"
        ? "cursor"
        : workingIndicator === "cat" || workingIndicator === "activity" ? workingIndicator : "pulse",
      promptNavigator: data.promptNavigator === "on" || data.promptNavigator === "off" ? data.promptNavigator : "auto",
      showMessageActions: data.showMessageActions !== false,
      messageCopyFormat: data.messageCopyFormat === "json" ? "json" : "markdown",
      headerMetrics: orderedIds(data.headerMetrics, HEADER_METRIC_IDS),
      responseActions: orderedIds(data.responseActions, RESPONSE_ACTION_IDS),
      topRailAlignment: data.topRailAlignment === "left" ? "left" : "center",
      jsonTreeDefault: data.jsonTreeDefault === "raw" ? "raw" : "tree",
      jsonTreeDepth: Number.isFinite(Number(data.jsonTreeDepth)) && Number(data.jsonTreeDepth) >= 0 ? Math.min(8, Math.round(Number(data.jsonTreeDepth))) : 2,
      editorAutosave: data.editorAutosave !== false,
      workStatusPanelEnabled: data.workStatusPanelEnabled !== false,
      workStatusHiddenSections: Array.isArray(data.workStatusHiddenSections)
        ? data.workStatusHiddenSections.filter((s): s is string => typeof s === "string").slice(0, 32)
        : [],
      showTechnicalButtons: data.showTechnicalButtons !== false,
      showDictate: data.showDictate !== false,
      showAutoApprove: data.showAutoApprove !== false,
      showGoals: data.showGoals !== false,
      showQuickActions: data.showQuickActions !== false,
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
  try {
    const current = localStorage.getItem(UI_SETTINGS_KEY);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_UI_SETTINGS_KEY);
    if (legacy === null) return null;
    const migrated = JSON.stringify(parseUiSettings(legacy));
    localStorage.setItem(UI_SETTINGS_KEY, migrated);
    return migrated;
  } catch {
    return null;
  }
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
  b.dataset.rounding = s.rounding;
  b.dataset.chatwidth = s.chatWidth;
  b.dataset.technical = String(s.showTechnicalButtons);
  b.dataset.dictate = String(s.showDictate);
  b.dataset.autoApprove = String(s.showAutoApprove);
  b.dataset.goals = String(s.showGoals);
  b.dataset.quickActions = String(s.showQuickActions);
  b.style?.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  const radii = s.rounding === "square"
    ? ["0px", "0px", "0px", "0px", "0px"]
    : s.rounding === "rounded"
      ? ["12px", "14px", "16px", "20px", "24px"]
      : ["8px", "10px", "10px", "12px", "16px"];
  b.style?.setProperty("--corner-radius-scale", s.rounding === "square" ? "0" : s.rounding === "rounded" ? "1.5" : "1");
  ["--radius-sm", "--radius", "--radius-md", "--radius-lg", "--radius-xl"]
    .forEach((name, index) => b.style?.setProperty(name, radii[index]!));
  b.style?.setProperty("--radius-control", radii[1]!);
  b.style?.setProperty("--radius-card", radii[3]!);
  b.style?.setProperty("--radius-surface", radii[4]!);
  b.style?.setProperty("--radius-sheet", radii[4]!);
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

/** Preview-capable editor families (mirrors liveFile.previewKindForPath). */
export type PreviewableKind = "markdown" | "html" | "json";
const PREVIEWABLE_KINDS: PreviewableKind[] = ["markdown", "html", "json"];

export interface EditorPrefs {
  openInPreview: boolean;
  /** UX-FILES-TIMELINE-03 finding 3: the last preview/edit choice per
   *  previewable kind. A kind's entry wins over openInPreview; a missing
   *  entry falls back to it. */
  previewByKind: Partial<Record<PreviewableKind, boolean>>;
}

export const EDITOR_PREFS_KEY = "polyth.editorPrefs";
export const EDITOR_PREFS_DEFAULTS: EditorPrefs = { openInPreview: true, previewByKind: {} };

export function parseEditorPrefs(raw: string | null): EditorPrefs {
  try {
    const value = JSON.parse(raw ?? "") as Partial<EditorPrefs>;
    const previewByKind: Partial<Record<PreviewableKind, boolean>> = {};
    if (typeof value.previewByKind === "object" && value.previewByKind !== null) {
      for (const kind of PREVIEWABLE_KINDS) {
        const v = (value.previewByKind as Record<string, unknown>)[kind];
        if (typeof v === "boolean") previewByKind[kind] = v;
      }
    }
    return { openInPreview: value.openInPreview !== false, previewByKind };
  } catch {
    return { openInPreview: true, previewByKind: {} };
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

/** Persist the user's preview/edit choice for one previewable kind (the
 *  toolbar switch calls this — programmatic mode flips must not). */
export function setEditorPreviewDefault(kind: PreviewableKind, on: boolean): void {
  setEditorPrefs({ previewByKind: { ...editorPrefs.previewByKind, [kind]: on } });
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
