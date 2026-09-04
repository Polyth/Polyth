// Local UI settings (Settings overlay pages). UI preferences use a dedicated,
// versioned record; `polyth.settings` is read only as a one-time migration
// source because older builds shared it with product-level settings.
import { useSyncExternalStore } from "react";
import type { NotificationKind } from "@polyth/contracts";

export type FollowUpBehavior = "steer" | "queue" | "interrupt";
export type LargeTextPasteBehavior = "ask" | "attach" | "inline";
export type NotificationKindPref = NotificationKind;
export type MessageCopyFormat = "markdown" | "json";
export type HeaderMetricId = "tokens" | "messages" | "duration" | "cost";
export type ResponseActionId = "copy" | "image" | "plan" | "pin" | "session" | "multirun";
export type TopRailAlignment = "center" | "left";
export type RailIconSize = "sm" | "md" | "lg";

export const HEADER_METRIC_IDS: readonly HeaderMetricId[] = ["tokens", "messages", "duration", "cost"];
export const RESPONSE_ACTION_IDS: readonly ResponseActionId[] = ["copy", "image", "plan", "pin", "session", "multirun"];
export const MOBILE_SHORTCUT_IDS = [
  "session", "files", "browser", "goals", "git", "terminal",
  "notification-centre", "multirun", "workflow", "fusion", "walkthrough",
  "schedule", "usage", "github", "knowledge", "context", "voice",
  "models-agents", "events", "diagnostics", "settings",
] as const;
export type MobileShortcutId = typeof MOBILE_SHORTCUT_IDS[number];

export interface UiSettings {
  density: "comfortable" | "balanced" | "compact";
  /** Retained for compatibility with older UI-preference records. */
  fontSize: "s" | "m" | "l";
  /** Header sizes include page, section, and surface titles. */
  headerFontSize: number;
  /** Subheaders include project and worktree names in the navigator. */
  subheaderFontSize: number;
  /** Terminal output and terminal input size in px. */
  terminalFontSize: number;
  /** Editor/composer font size in px (WP2/WP9 font tokens). */
  editorFontSize: number;
  /** Shared corner treatment for controls, panels, and overlays (0 = square, 10 = rounded). */
  rounding: number;
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
  /** Large clipboard text: ask, attach as file, or paste inline (WS9). */
  largeTextPasteBehavior: LargeTextPasteBehavior;
  /** Merged thinking display (WP4). */
  collapsibleThinkingBlocks: boolean;
  thinkingDefaultExpanded: boolean;
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
  /** Visual button and glyph scale for workspace tools in the application header. */
  topRailIconSize: RailIconSize;
  /** Visual button and glyph scale for launchers in the right rail. */
  rightRailIconSize: RailIconSize;
  /** Ordered shortcuts in the swipeable compact-shell top rail. */
  mobileShortcuts: MobileShortcutId[];
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
  headerFontSize: 24,
  subheaderFontSize: 16,
  terminalFontSize: 14,
  editorFontSize: 14,
  rounding: 5,
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
  largeTextPasteBehavior: "ask",
  collapsibleThinkingBlocks: true,
  thinkingDefaultExpanded: false,
  promptNavigator: "auto",
  showMessageActions: true,
  messageCopyFormat: "markdown",
  headerMetrics: [...HEADER_METRIC_IDS],
  responseActions: [...RESPONSE_ACTION_IDS],
  topRailAlignment: "center",
  topRailIconSize: "md",
  rightRailIconSize: "md",
  mobileShortcuts: [
    "session", "workflow", "files", "git", "terminal", "browser",
    "notification-centre", "goals", "settings",
  ],
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

function parseRounding(value: unknown): number {
  // Keep the three pre-slider values working for existing local preferences.
  if (value === "square") return 0;
  if (value === "compact") return 5;
  if (value === "rounded") return 10;
  const rounded = Math.round(Number(value));
  return Number.isFinite(rounded) && rounded >= 0 && rounded <= 10 ? rounded : UI_DEFAULTS.rounding;
}

function parseRailIconSize(value: unknown): RailIconSize {
  return value === "sm" || value === "lg" ? value : "md";
}

function parseFontSize(value: unknown, fallback: number, min = 10, max = 32): number {
  const px = Number(value);
  return Number.isFinite(px) && px >= min && px <= max ? Math.round(px) : fallback;
}

export function parseUiSettings(raw: string | null): UiSettings {
  const d: UiSettings = {
    ...UI_DEFAULTS,
    mcpServers: [],
    notifyKinds: [...UI_DEFAULTS.notifyKinds],
    workStatusHiddenSections: [],
    mobileShortcuts: [...UI_DEFAULTS.mobileShortcuts],
  };
  try {
    const data = JSON.parse(raw ?? "") as Partial<UiSettings>;
    const editorFontSize = parseFontSize(data.editorFontSize, UI_DEFAULTS.editorFontSize);
    return {
      density: data.density === "compact" || data.density === "balanced" ? data.density : "comfortable",
      fontSize: data.fontSize === "s" || data.fontSize === "l" ? data.fontSize : "m",
      headerFontSize: parseFontSize(data.headerFontSize, UI_DEFAULTS.headerFontSize, 14, 48),
      subheaderFontSize: parseFontSize(data.subheaderFontSize, UI_DEFAULTS.subheaderFontSize),
      // Older records used editorFontSize for both terminal and editor text.
      terminalFontSize: parseFontSize(data.terminalFontSize, editorFontSize),
      editorFontSize,
      rounding: parseRounding(data.rounding),
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
      largeTextPasteBehavior: data.largeTextPasteBehavior === "attach" || data.largeTextPasteBehavior === "inline"
        ? data.largeTextPasteBehavior
        : "ask",
      collapsibleThinkingBlocks: data.collapsibleThinkingBlocks !== false,
      thinkingDefaultExpanded: data.thinkingDefaultExpanded === true,
      promptNavigator: data.promptNavigator === "on" || data.promptNavigator === "off" ? data.promptNavigator : "auto",
      showMessageActions: data.showMessageActions !== false,
      messageCopyFormat: data.messageCopyFormat === "json" ? "json" : "markdown",
      headerMetrics: orderedIds(data.headerMetrics, HEADER_METRIC_IDS),
      responseActions: orderedIds(data.responseActions, RESPONSE_ACTION_IDS),
      topRailAlignment: data.topRailAlignment === "left" ? "left" : "center",
      topRailIconSize: parseRailIconSize(data.topRailIconSize),
      rightRailIconSize: parseRailIconSize(data.rightRailIconSize),
      mobileShortcuts: Array.isArray(data.mobileShortcuts)
        ? orderedIds(data.mobileShortcuts, MOBILE_SHORTCUT_IDS)
        : [...UI_DEFAULTS.mobileShortcuts],
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

const RAIL_ICON_GEOMETRY: Record<RailIconSize, { box: string; glyph: string }> = {
  sm: {
    box: "calc(var(--control-h-sm) - var(--space-1))",
    glyph: "var(--icon-sm)",
  },
  md: {
    box: "var(--control-h-sm)",
    glyph: "var(--icon-md)",
  },
  lg: {
    box: "calc(var(--control-h-sm) + var(--space-1))",
    glyph: "var(--icon-lg)",
  },
};

/** Reflect visual prefs onto <body> data attributes (CSS reads them). */
export function applyUiSettings(s: UiSettings = settings): void {
  if (typeof document === "undefined") return;
  const b = document.body;
  b.dataset.density = s.density;
  b.dataset.rounding = String(s.rounding);
  b.dataset.chatwidth = s.chatWidth;
  b.dataset.technical = String(s.showTechnicalButtons);
  b.dataset.dictate = String(s.showDictate);
  b.dataset.autoApprove = String(s.showAutoApprove);
  b.dataset.goals = String(s.showGoals);
  b.dataset.quickActions = String(s.showQuickActions);
  b.style?.setProperty("--header-font-size", `${s.headerFontSize}px`);
  b.style?.setProperty("--subheader-font-size", `${s.subheaderFontSize}px`);
  b.style?.setProperty("--terminal-font-size", `${s.terminalFontSize}px`);
  // Existing role tokens are consumed by package CSS too. Publish their
  // computed values on body so independently bundled styles follow the same
  // setting without importing shell state.
  b.style?.setProperty("--font-title", `${s.headerFontSize}px`);
  b.style?.setProperty("--font-heading", `${s.headerFontSize}px`);
  b.style?.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  const topRail = RAIL_ICON_GEOMETRY[s.topRailIconSize];
  const rightRail = RAIL_ICON_GEOMETRY[s.rightRailIconSize];
  b.style?.setProperty("--rail-icon-size-top", topRail.box);
  b.style?.setProperty("--rail-icon-glyph-top", topRail.glyph);
  b.style?.setProperty("--rail-strip-width-top", "calc(var(--rail-icon-size-top) + var(--space-2))");
  b.style?.setProperty("--rail-icon-size-right", rightRail.box);
  b.style?.setProperty("--rail-icon-glyph-right", rightRail.glyph);
  b.style?.setProperty("--rail-strip-width-right", "calc(var(--rail-icon-size-right) + var(--space-3))");
  // Every radius token derives from the one scale in tokens.css. Tokens are
  // declared on :root, so their var(--corner-radius-scale) resolves there too —
  // a scale set on <body> would never reach them. Do not publish a second
  // runtime radius vocabulary here.
  document.documentElement.style?.setProperty("--corner-radius-scale", String(s.rounding / 5));
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

/** Non-React subscription to UI-preference changes (settings server sync). */
export function subscribeUiSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
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
