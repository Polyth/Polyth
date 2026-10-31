// Local UI settings (Settings overlay pages). UI preferences use a dedicated,
// versioned record; `polyth.settings` is read only as a one-time migration
// source because older builds shared it with product-level settings.
import { useSyncExternalStore } from "react";
import type { NotificationKind, PromptHistoryScope } from "@polyth/contracts";
import { clampPromptHistoryLimit, parsePromptHistoryScope, PROMPT_HISTORY_DEFAULT_LIMIT } from "@polyth/contracts";
import {
  ASSISTANT_MESSAGE_ACTIONS_DEFAULT,
  cloneMessageActionLayout,
  migrateLegacyResponseActions,
  parseMessageActionLayout,
  RESPONSE_ACTION_IDS,
  USER_MESSAGE_ACTION_IDS,
  USER_MESSAGE_ACTIONS_DEFAULT,
  type MessageActionLayout,
  type ResponseActionId,
  type UserMessageActionId,
  type WithPackageActions,
} from "./messageActionLayout.ts";

export { RESPONSE_ACTION_IDS, USER_MESSAGE_ACTION_IDS };
export type { ResponseActionId, UserMessageActionId };

export type FollowUpBehavior = "steer" | "queue" | "interrupt";
export type LargeTextPasteBehavior = "ask" | "attach" | "inline";
export type NotificationKindPref = NotificationKind;
export type MessageCopyFormat = "markdown" | "json";
export type HeaderMetricId = "tokens" | "messages" | "duration" | "cost";
export type TopRailAlignment = "center" | "left";
export type GlassEffect = "off" | "matte" | "clear";
/** How the top rail separates from the workspace below it: `shadow` keeps the
 *  bottom edge, `flat` drops the edge but keeps the bar, `floating` drops the
 *  bar too so its menus and icons read as free-standing. */
export type TopRailSurface = "shadow" | "flat" | "floating";
export const TOP_RAIL_SURFACES: readonly TopRailSurface[] = ["shadow", "flat", "floating"];
/** Whole-shell interface style (`shellLooks.css`). `standard` is the default
 *  glass shell; the others restyle chrome, conversation, cards and overlays
 *  and follow the Wallpaper and Transparency settings. */
export type ShellLook = "standard" | "paper" | "line" | "air" | "monolith" | "monolith-reverse" | "obsidian" | "editorial";
export const SHELL_LOOKS: readonly ShellLook[] = ["standard", "paper", "line", "air", "monolith", "monolith-reverse", "obsidian", "editorial"];
/** How a wide window shares its height (shellLayout.ts): `classic` keeps the
 *  full-width top bar above the side columns; `columns` runs the side columns
 *  the full height with the bar between them; `bare` drops the bar and moves
 *  its controls into the columns. Tablet and phone keep their own headers. */
export type ShellLayout = "classic" | "columns" | "bare";
export const SHELL_LAYOUTS: readonly ShellLayout[] = ["classic", "columns", "bare"];
/** The `columns` bar: tools, title and actions spread across the gap, or
 *  gathered into one glass island over the chat. */
export type ShellBarStyle = "spread" | "island";
export const SHELL_BAR_STYLES: readonly ShellBarStyle[] = ["spread", "island"];
/** Where a group of former top-bar controls lives in the `bare` layout: the
 *  navigator's column (`start`), the launcher strip (`end`), or nowhere. */
export type ShellDockSide = "start" | "end" | "hidden";
export const SHELL_DOCK_SIDES: readonly ShellDockSide[] = ["start", "end", "hidden"];
/** The `bare` layout's chat title: a quiet line over the chat, or none. */
export type ShellTitlePlacement = "chat" | "hidden";
export const SHELL_TITLE_PLACEMENTS: readonly ShellTitlePlacement[] = ["chat", "hidden"];
/** When the status bar under the workspace is shown: never, only while a
 *  workflow run is active (progress and approval prompts), or always. */
export type StatusBarMode = "off" | "workflows" | "always";
export const STATUS_BAR_MODES: readonly StatusBarMode[] = ["off", "workflows", "always"];
/** Where a phone swipe may start to open the Navigator or the Workspace, close
 *  them, or go Back from a package window: anywhere on the screen, only from
 *  its edges, or never. */
export type SwipeNavigationMode = "surface" | "edge" | "off";
export const SWIPE_NAVIGATION_MODES: readonly SwipeNavigationMode[] = ["surface", "edge", "off"];

/** Rail size is a percentage of the default geometry; 100 keeps today's pixels. */
export const RAIL_SIZE_MIN = 70;
export const RAIL_SIZE_MAX = 130;
export const RAIL_SIZE_STEP = 5;
export const RAIL_SIZE_DEFAULT = 100;
/** Space between icons in every rail, in px. Touch
 *  pointers never go below an 8px gap so the pitch stays a full tap target. */
export const RAIL_SPACING_MIN = 0;
export const RAIL_SPACING_MAX = 20;
export const RAIL_SPACING_STEP = 2;
export const RAIL_SPACING_DEFAULT = 6;
/** The spacing of records saved before the setting existed. */
const RAIL_SPACING_LEGACY = 4;
// Earlier defaults, read for a saved record that lacks the field.
const LEGACY_ROUNDING = 5;
const LEGACY_HEADER_FONT_SIZE = 24;
const LEGACY_MOBILE_SHORTCUTS = ["files", "git", "terminal", "browser", "notification-centre", "settings"] as const;
/** The window of records saved before the bare, floating-column layout with
 *  the account and actions in the navigator's column became the default. */
const LEGACY_SHELL_LAYOUT: ShellLayout = "classic";
const LEGACY_SHELL_ACTIONS_DOCK: ShellDockSide = "end";
export type ActionGrouping = "grouped" | "ungrouped";
export type ThinkingDisplayMode = "collapsed" | "expanded" | "activity";
export type SessionActivityDetailsMode = "tabs" | "all";
/** How agent activity blocks draw in the transcript (docs/dev/ui.md). */
export const ACTIVITY_BLOCK_STYLES = ["thread", "ledger", "chip", "margin"] as const;
export type ActivityBlockStyle = typeof ACTIVITY_BLOCK_STYLES[number];
/** How the agent status and edited-files line above the composer draws. */
export const COMPOSER_STATUS_STYLES = ["line", "tab", "capsule"] as const;
export type ComposerStatusStyle = typeof COMPOSER_STATUS_STYLES[number];
export type MobileSessionTitleMode = "hidden" | "title" | "button";

export const HEADER_METRIC_IDS: readonly HeaderMetricId[] = ["tokens", "messages", "duration", "cost"];
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
  /** Editor/composer font size in px (font tokens). */
  editorFontSize: number;
  /** Shared corner treatment for controls, panels, and overlays (0 = square, 10 = rounded). */
  rounding: number;
  /** One material treatment for shell chrome, conversation blocks, and overlays. */
  glassEffect: GlassEffect;
  /** Remove interface borders except subtle resize edges and the composer. */
  hideBorders: boolean;
  /** Whole-shell interface style; `standard` keeps the default shell. */
  shellLook: ShellLook;
  /** Mirror the wide shell: sidebar and project rail on the right, tools on the left. */
  mirrorLayout: boolean;
  chatWidth: "normal" | "wide";
  /** Browser notification when a turn finishes in a hidden tab. */
  notifyOnComplete: boolean;
  /** Short beep when a turn finishes. */
  notifySound: boolean;
  /** Notification kinds routed to the OS/browser layer. */
  notifyKinds: NotificationKindPref[];
  /** Which kinds `notifyKinds` was chosen against. A record from before a
   *  kind existed (older shells drop fields they do not know) gets that kind
   *  switched on once: `mention` (2), `message` (3). */
  notifyKindsVersion: number;
  notifyOnlyWhenHidden: boolean;
  /** Notification body template; allowlisted vars {project} {session} {status} {preview}. */
  notifyTemplate: string;
  /** NTF-01: keep read rows visible in the notification centre. Per-browser
   *  display filter only — never disables recording or clears server data. */
  notificationCentreHistory: boolean;
  confirmSessionArchive: boolean;
  autoScroll: boolean;
  /** Send behavior while a turn is active. */
  followUpBehavior: FollowUpBehavior;
  largeTextPasteBehavior: LargeTextPasteBehavior;
  /** Group tool/task actions into activity cards or render each independently. */
  actionGrouping: ActionGrouping;
  /** Keep thinking collapsed, expanded, or inside a grouped activity block. */
  thinkingDisplayMode: ThinkingDisplayMode;
  /** Open agent activity details as tabs or as one vertically scrollable view. */
  sessionActivityDetails: SessionActivityDetailsMode;
  /** Activity block look: thread, ledger, chip or hanging margin icons. */
  activityBlockStyle: ActivityBlockStyle;
  /** Above-composer status and edited files: line, tab or capsule. */
  composerStatusStyle: ComposerStatusStyle;
  /** Phone session title: hidden, transparent, or a full glass button. */
  mobileSessionTitle: MobileSessionTitleMode;
  /** Prompt navigator rail. Settings expose it as on (`auto`) / off;
   * a stored `on` still forces the rail even for short chats. */
  promptNavigator: "auto" | "on" | "off";
  /** Chat edge the desktop prompt rail hugs. */
  promptNavigatorSide: "left" | "right";
  /** Show the quick actions under user messages. */
  showMessageActions: boolean;
  /** Show the opt-in conversation prompt history bookmark on phones and
   * windows too narrow for the rail. The field keeps its original name so
   * existing account settings migrate in place. */
  pinLatestPrompt: boolean;
  /** Show the same bookmark in wide windows, alongside the rail when that is on. */
  promptBookmarkDesktop: boolean;
  /** Payload selected by the single message Copy action. */
  messageCopyFormat: MessageCopyFormat;
  /** Visible session-header metrics, in drag-configured order. */
  headerMetrics: HeaderMetricId[];
  /** User-message quick actions: order, bar/menu placement, reveal. Package
   *  buttons are entries too (`pkg:<contribution id>`). */
  userMessageActions: MessageActionLayout<WithPackageActions<UserMessageActionId>>;
  /** Assistant-answer quick actions, in the same shape as user messages. */
  assistantMessageActions: MessageActionLayout<WithPackageActions<ResponseActionId>>;
  /** Show answer quick actions; hidden controls keep their layout space. */
  showAnswerQuickActions: boolean;
  /** Placement of the configured Chat top rail in the application header. */
  topRailAlignment: TopRailAlignment;
  /** Bottom-edge treatment of the top rail against the workspace below. */
  topRailSurface: TopRailSurface;
  /** How the wide window shares its height between the top bar and columns. */
  shellLayout: ShellLayout;
  /** The `columns` bar: spread across the gap or one island over the chat. */
  shellBarStyle: ShellBarStyle;
  /** Full-height columns float inside the window with every corner rounded. */
  floatingColumns: boolean;
  /** `bare` layout: where the top rail's tools go. */
  shellToolsDock: ShellDockSide;
  /** `bare` layout: where the header actions (search, notifications…) go. */
  shellActionsDock: ShellDockSide;
  /** `bare` layout: the chat title over the conversation, or none. */
  shellTitle: ShellTitlePlacement;
  /** Percentage scale of the top rail controls and their icons. */
  topRailSize: number;
  /** Percentage scale of the right launcher strip and its icons. */
  rightRailSize: number;
  /** Percentage scale of the left navigation rail and its icons. */
  leftRailSize: number;
  /** Gap between icons in the left, right and top rails, in px. */
  railSpacing: number;
  /** Ordered shortcuts in the swipeable compact-shell top rail. */
  mobileShortcuts: MobileShortcutId[];
  /** JSON tree viewer defaults. */
  jsonTreeDefault: "tree" | "raw";
  jsonTreeDepth: number;
  /** Revision-guarded editor autosave. */
  editorAutosave: boolean;
  showTechnicalButtons: boolean;
  showDictate: boolean;
  /** Composer shield control visibility; the session policy remains server-owned. */
  showAutoApprove: boolean;
  /** Composer target control visibility. */
  showGoals: boolean;
  showQuickActions: boolean;
  /** The opt-in status bar under the workspace; off until the user turns it on. */
  statusBar: StatusBarMode;
  /** Phone swipe navigation (Navigator, Workspace, package Back). */
  swipeNavigation: SwipeNavigationMode;
  /** While a package window is pinned, opening another one keeps the pinned
   *  frame — same mode, width, edge and strip height; only content changes. */
  sharedPinnedWindow: boolean;
  /** Which default `sharedPinnedWindow` was saved against. A record without
   *  the current value was written while the frame was opt-in, so its `false`
   *  is the old default, not a choice: it switches on once. */
  sharedPinnedWindowVersion: number;
  /** MCP server entries (mirrored with the account UI settings; runtime
   * integration pending). */
  mcpServers: Array<{ name: string; url: string }>;
  /** Composer ArrowUp/Down prompt history: this session, or every project in this Space. */
  promptHistoryScope: PromptHistoryScope;
  /** Maximum submitted prompts recalled by history navigation. */
  promptHistoryLimit: number;
}

export const UI_SETTINGS_KEY = "polyth.uiSettings.v1";
export const LEGACY_UI_SETTINGS_KEY = "polyth.settings";

/** A fresh install's settings. A saved record that lacks a field keeps that
 *  field's earlier value (see `parseUiSettings`), so changing a default here
 *  never silently restyles an existing profile. */
/** Bumped when a notification kind that should default on is added. */
const NOTIFY_KINDS_VERSION = 3;
/** Bumped when the kept pinned frame became the default. */
const SHARED_PINNED_WINDOW_VERSION = 2;

export const UI_DEFAULTS: UiSettings = {
  density: "compact",
  fontSize: "m",
  headerFontSize: 22,
  subheaderFontSize: 16,
  terminalFontSize: 14,
  editorFontSize: 14,
  // The theme styles divide the scale by 1.8 (9 / 5) so this default draws
  // their native radii; change both together.
  rounding: 9,
  glassEffect: "matte",
  hideBorders: true,
  shellLook: "standard",
  mirrorLayout: false,
  chatWidth: "normal",
  notifyOnComplete: false,
  notifySound: false,
  notifyKinds: ["completed", "failed", "question", "permission", "mention", "message"],
  notifyKindsVersion: NOTIFY_KINDS_VERSION,
  notifyOnlyWhenHidden: true,
  notifyTemplate: "{session} — {status}",
  notificationCentreHistory: true,
  confirmSessionArchive: false,
  autoScroll: true,
  followUpBehavior: "queue",
  largeTextPasteBehavior: "ask",
  actionGrouping: "grouped",
  thinkingDisplayMode: "collapsed",
  sessionActivityDetails: "all",
  activityBlockStyle: "thread",
  composerStatusStyle: "line",
  mobileSessionTitle: "hidden",
  promptNavigator: "auto",
  promptNavigatorSide: "left",
  showMessageActions: true,
  pinLatestPrompt: false,
  promptBookmarkDesktop: false,
  messageCopyFormat: "markdown",
  headerMetrics: [...HEADER_METRIC_IDS],
  userMessageActions: USER_MESSAGE_ACTIONS_DEFAULT,
  assistantMessageActions: ASSISTANT_MESSAGE_ACTIONS_DEFAULT,
  showAnswerQuickActions: true,
  topRailAlignment: "center",
  topRailSurface: "floating",
  // A fresh window is the chat between two floating columns and no top bar:
  // the tools go to the launcher strip; search, notifications, Settings and
  // the account close the navigator's column, so it shows one Settings gear.
  shellLayout: "bare",
  shellBarStyle: "spread",
  floatingColumns: true,
  shellToolsDock: "end",
  shellActionsDock: "start",
  shellTitle: "chat",
  topRailSize: RAIL_SIZE_DEFAULT,
  rightRailSize: 90,
  leftRailSize: RAIL_SIZE_DEFAULT,
  railSpacing: RAIL_SPACING_DEFAULT,
  mobileShortcuts: [
    "workflow", "files", "git", "terminal", "browser", "notification-centre", "goals", "settings",
  ],
  jsonTreeDefault: "tree",
  jsonTreeDepth: 2,
  editorAutosave: true,
  showTechnicalButtons: true,
  showDictate: true,
  showAutoApprove: true,
  showGoals: true,
  showQuickActions: true,
  statusBar: "off",
  swipeNavigation: "surface",
  sharedPinnedWindow: true,
  sharedPinnedWindowVersion: SHARED_PINNED_WINDOW_VERSION,
  mcpServers: [],
  promptHistoryScope: "session",
  promptHistoryLimit: PROMPT_HISTORY_DEFAULT_LIMIT,
};

const NOTIFY_KINDS: NotificationKindPref[] = ["completed", "failed", "question", "permission", "subagent", "mention", "message"];

function orderedIds<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...allowed];
  const seen = new Set<T>();
  return value.filter((id): id is T => {
    if (typeof id !== "string" || !allowed.includes(id as T) || seen.has(id as T)) return false;
    seen.add(id as T);
    return true;
  });
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function parseRounding(value: unknown): number {
  // Keep the three pre-slider values working for existing local preferences.
  if (value === "square") return 0;
  if (value === "compact") return 5;
  if (value === "rounded") return 10;
  const rounded = Math.round(Number(value));
  return Number.isFinite(rounded) && rounded >= 0 && rounded <= 10 ? rounded : LEGACY_ROUNDING;
}

/** Parse one rail scale. Legacy discrete records (sm/md/lg) migrate to the
 *  nearest percentage so an older profile keeps roughly its chosen density. */
function parseRailSize(value: unknown): number {
  if (value === "sm") return 90;
  if (value === "lg") return 110;
  if (value === "md") return RAIL_SIZE_DEFAULT;
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return RAIL_SIZE_DEFAULT;
  return Math.min(RAIL_SIZE_MAX, Math.max(RAIL_SIZE_MIN, size));
}

function parseRailSpacing(value: unknown): number {
  const px = Number(value);
  if (value === undefined || value === null || !Number.isFinite(px)) return RAIL_SPACING_LEGACY;
  const stepped = Math.round(px / RAIL_SPACING_STEP) * RAIL_SPACING_STEP;
  return Math.min(RAIL_SPACING_MAX, Math.max(RAIL_SPACING_MIN, stepped));
}

function parseFontSize(value: unknown, fallback: number, min = 10, max = 32): number {
  const px = Number(value);
  return Number.isFinite(px) && px >= min && px <= max ? Math.round(px) : fallback;
}

function parseThinkingDisplayMode(value: unknown, legacyValue: unknown, actionGrouping: ActionGrouping): ThinkingDisplayMode {
  if (value === "collapsed" || value === "expanded" || (value === "activity" && actionGrouping === "grouped")) return value;
  return legacyValue === false ? "expanded" : "collapsed";
}

function parseNotifyKinds(value: unknown, version: unknown): NotificationKindPref[] {
  if (!Array.isArray(value)) return [...UI_DEFAULTS.notifyKinds];
  const kinds = value.filter((k): k is NotificationKindPref => NOTIFY_KINDS.includes(k as NotificationKindPref));
  // A list chosen before a kind existed gains it once; after that the
  // person's opt-out sticks. Version 2 added `mention`, 3 `message`.
  const chosenAt = typeof version === "number" ? version : 1;
  if (chosenAt < 2 && !kinds.includes("mention")) kinds.push("mention");
  if (chosenAt < 3 && !kinds.includes("message")) kinds.push("message");
  return kinds;
}

export function parseUiSettings(raw: string | null): UiSettings {
  const d: UiSettings = {
    ...UI_DEFAULTS,
    mcpServers: [],
    notifyKinds: [...UI_DEFAULTS.notifyKinds],
    mobileShortcuts: [...UI_DEFAULTS.mobileShortcuts],
    userMessageActions: cloneMessageActionLayout(UI_DEFAULTS.userMessageActions),
    assistantMessageActions: cloneMessageActionLayout(UI_DEFAULTS.assistantMessageActions),
  };
  try {
    const data = JSON.parse(raw ?? "") as Partial<UiSettings>;
    const legacyThinking = (data as { collapsibleThinkingBlocks?: unknown }).collapsibleThinkingBlocks;
    const actionGrouping: ActionGrouping = data.actionGrouping === "ungrouped" ? "ungrouped" : "grouped";
    const editorFontSize = parseFontSize(data.editorFontSize, UI_DEFAULTS.editorFontSize);
    return {
      density: data.density === "compact" || data.density === "balanced" ? data.density : "comfortable",
      fontSize: data.fontSize === "s" || data.fontSize === "l" ? data.fontSize : "m",
      headerFontSize: parseFontSize(data.headerFontSize, LEGACY_HEADER_FONT_SIZE, 14, 48),
      subheaderFontSize: parseFontSize(data.subheaderFontSize, UI_DEFAULTS.subheaderFontSize),
      // Older records used editorFontSize for both terminal and editor text.
      terminalFontSize: parseFontSize(data.terminalFontSize, editorFontSize),
      editorFontSize,
      rounding: parseRounding(data.rounding),
      glassEffect: data.glassEffect === "off" || data.glassEffect === "clear" ? data.glassEffect : "matte",
      hideBorders: typeof data.hideBorders === "boolean" ? data.hideBorders : UI_DEFAULTS.hideBorders,
      shellLook: SHELL_LOOKS.includes(data.shellLook as ShellLook) ? data.shellLook as ShellLook : UI_DEFAULTS.shellLook,
      mirrorLayout: typeof data.mirrorLayout === "boolean" ? data.mirrorLayout : UI_DEFAULTS.mirrorLayout,
      chatWidth: data.chatWidth === "wide" ? "wide" : "normal",
      notifyOnComplete: data.notifyOnComplete === true,
      notifySound: data.notifySound === true,
      notifyKinds: parseNotifyKinds(data.notifyKinds, data.notifyKindsVersion),
      notifyKindsVersion: NOTIFY_KINDS_VERSION,
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
      actionGrouping,
      thinkingDisplayMode: parseThinkingDisplayMode(data.thinkingDisplayMode, legacyThinking, actionGrouping),
      sessionActivityDetails: data.sessionActivityDetails === "all" ? "all" : "tabs",
      activityBlockStyle: ACTIVITY_BLOCK_STYLES.includes(data.activityBlockStyle as ActivityBlockStyle)
        ? data.activityBlockStyle as ActivityBlockStyle
        : UI_DEFAULTS.activityBlockStyle,
      composerStatusStyle: COMPOSER_STATUS_STYLES.includes(data.composerStatusStyle as ComposerStatusStyle)
        ? data.composerStatusStyle as ComposerStatusStyle
        : UI_DEFAULTS.composerStatusStyle,
      // The retired `logo` mode falls back to the plain title.
      mobileSessionTitle: data.mobileSessionTitle === "hidden" || data.mobileSessionTitle === "button"
        ? data.mobileSessionTitle : "title",
      promptNavigator: data.promptNavigator === "on" || data.promptNavigator === "off" ? data.promptNavigator : "auto",
      promptNavigatorSide: data.promptNavigatorSide === "left" ? "left" : "right",
      showMessageActions: data.showMessageActions !== false,
      pinLatestPrompt: data.pinLatestPrompt === true,
      promptBookmarkDesktop: data.promptBookmarkDesktop === true,
      messageCopyFormat: data.messageCopyFormat === "json" ? "json" : "markdown",
      headerMetrics: orderedIds(data.headerMetrics, HEADER_METRIC_IDS),
      userMessageActions: parseMessageActionLayout(data.userMessageActions, USER_MESSAGE_ACTION_IDS, UI_DEFAULTS.userMessageActions),
      // `responseActions` (an ordered id list) predates the shared layout and
      // is read only as a migration source.
      assistantMessageActions: data.assistantMessageActions !== undefined
        ? parseMessageActionLayout(data.assistantMessageActions, RESPONSE_ACTION_IDS, UI_DEFAULTS.assistantMessageActions)
        : migrateLegacyResponseActions((data as { responseActions?: unknown }).responseActions),
      showAnswerQuickActions: data.showAnswerQuickActions !== false,
      topRailAlignment: data.topRailAlignment === "left" ? "left" : "center",
      // A saved profile without the field keeps the bottom edge it was built
      // with; only a fresh install starts from UI_DEFAULTS.
      topRailSurface: TOP_RAIL_SURFACES.includes(data.topRailSurface as TopRailSurface)
        ? data.topRailSurface as TopRailSurface
        : "shadow",
      // A saved profile without these keeps the window it was built with.
      shellLayout: oneOf(data.shellLayout, SHELL_LAYOUTS, LEGACY_SHELL_LAYOUT),
      shellBarStyle: oneOf(data.shellBarStyle, SHELL_BAR_STYLES, UI_DEFAULTS.shellBarStyle),
      floatingColumns: typeof data.floatingColumns === "boolean" ? data.floatingColumns : UI_DEFAULTS.floatingColumns,
      shellToolsDock: oneOf(data.shellToolsDock, SHELL_DOCK_SIDES, UI_DEFAULTS.shellToolsDock),
      shellActionsDock: oneOf(data.shellActionsDock, SHELL_DOCK_SIDES, LEGACY_SHELL_ACTIONS_DOCK),
      shellTitle: oneOf(data.shellTitle, SHELL_TITLE_PLACEMENTS, UI_DEFAULTS.shellTitle),
      // The discrete topRailIconSize/rightRailIconSize records predate the
      // sliders; read them as a migration source only.
      topRailSize: parseRailSize(data.topRailSize ?? (data as { topRailIconSize?: unknown }).topRailIconSize),
      rightRailSize: parseRailSize(data.rightRailSize ?? (data as { rightRailIconSize?: unknown }).rightRailIconSize),
      leftRailSize: parseRailSize(data.leftRailSize),
      railSpacing: parseRailSpacing(data.railSpacing),
      mobileShortcuts: Array.isArray(data.mobileShortcuts)
        ? orderedIds(data.mobileShortcuts, MOBILE_SHORTCUT_IDS)
        : [...LEGACY_MOBILE_SHORTCUTS],
      jsonTreeDefault: data.jsonTreeDefault === "raw" ? "raw" : "tree",
      jsonTreeDepth: Number.isFinite(Number(data.jsonTreeDepth)) && Number(data.jsonTreeDepth) >= 0 ? Math.min(8, Math.round(Number(data.jsonTreeDepth))) : 2,
      editorAutosave: data.editorAutosave !== false,
      showTechnicalButtons: data.showTechnicalButtons !== false,
      showDictate: data.showDictate !== false,
      showAutoApprove: data.showAutoApprove !== false,
      showGoals: data.showGoals !== false,
      showQuickActions: data.showQuickActions !== false,
      statusBar: STATUS_BAR_MODES.includes(data.statusBar as StatusBarMode)
        ? data.statusBar as StatusBarMode
        : UI_DEFAULTS.statusBar,
      swipeNavigation: SWIPE_NAVIGATION_MODES.includes(data.swipeNavigation as SwipeNavigationMode)
        ? data.swipeNavigation as SwipeNavigationMode
        : UI_DEFAULTS.swipeNavigation,
      sharedPinnedWindow: data.sharedPinnedWindowVersion === SHARED_PINNED_WINDOW_VERSION
        ? data.sharedPinnedWindow !== false
        : true,
      sharedPinnedWindowVersion: SHARED_PINNED_WINDOW_VERSION,
      mcpServers: Array.isArray(data.mcpServers)
        ? data.mcpServers
            .filter((s): s is { name: string; url: string } => !!s && typeof s.name === "string" && typeof s.url === "string")
            .slice(0, 32)
        : [],
      promptHistoryScope: parsePromptHistoryScope(data.promptHistoryScope),
      promptHistoryLimit: clampPromptHistoryLimit(data.promptHistoryLimit),
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

/** Rail geometry derives from one percentage per rail. The top rail keeps the
 *  md glyph; the left project rail and right launcher strip share the rail
 *  glyph so their icons read as a pair. */
function railGeometry(
  scale: number,
  glyphToken: "--icon-md" | "--icon-rail" = "--icon-md",
): { box: string; glyph: string } {
  return {
    box: `calc(var(--control-h-sm) * ${scale})`,
    glyph: `calc(var(${glyphToken}) * ${scale})`,
  };
}

/** A section heading sits one clear step below the page title (0.75×), never
 *  under the 15px label caliber and never above the title itself. */
export function sectionHeadingSize(headerFontSize: number): number {
  return Math.min(headerFontSize, Math.max(15, Math.round(headerFontSize * 0.75)));
}

/** Reflect visual prefs onto <body> data attributes (CSS reads them). */
export function applyUiSettings(s: UiSettings = settings): void {
  if (typeof document === "undefined") return;
  const b = document.body;
  b.dataset.density = s.density;
  b.dataset.rounding = String(s.rounding);
  b.dataset.glass = s.glassEffect;
  b.dataset.hideBorders = String(s.hideBorders);
  b.dataset.shellLook = s.shellLook;
  b.dataset.topRailSurface = s.topRailSurface;
  b.dataset.chatwidth = s.chatWidth;
  b.dataset.mobileSessionTitle = s.mobileSessionTitle;
  b.dataset.activityStyle = s.activityBlockStyle;
  b.dataset.composerStatusStyle = s.composerStatusStyle;
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
  b.style?.setProperty("--font-heading", `${sectionHeadingSize(s.headerFontSize)}px`);
  b.style?.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  // `--font-code` is declared on :root as var(--editor-font-size). A body-only
  // editor size never reaches that alias, so publish the same value on <html>.
  document.documentElement.style?.setProperty("--editor-font-size", `${s.editorFontSize}px`);
  const topRail = railGeometry(s.topRailSize / 100);
  const rightRail = railGeometry(s.rightRailSize / 100, "--icon-rail");
  const leftRail = railGeometry(s.leftRailSize / 100, "--icon-rail");
  // The left track widths are derived in CSS from this scale; the sidebar's JS
  // geometry reads the same number so its sessions column stays flush. All
  // three scales are published so packages can follow the same preference.
  b.style?.setProperty("--rail-scale-left", String(s.leftRailSize / 100));
  b.style?.setProperty("--rail-scale-right", String(s.rightRailSize / 100));
  b.style?.setProperty("--rail-scale-top", String(s.topRailSize / 100));
  // One spacing preference for every rail; the rails read it as their gap.
  b.style?.setProperty("--rail-gap", `${s.railSpacing}px`);
  b.style?.setProperty("--rail-icon-size-left", leftRail.box);
  b.style?.setProperty("--rail-icon-glyph-left", leftRail.glyph);
  b.style?.setProperty("--rail-icon-size-top", topRail.box);
  b.style?.setProperty("--rail-icon-glyph-top", topRail.glyph);
  b.style?.setProperty("--rail-strip-width-top", "calc(var(--rail-icon-size-top) + var(--space-2))");
  b.style?.setProperty("--rail-icon-size-right", rightRail.box);
  b.style?.setProperty("--rail-icon-glyph-right", rightRail.glyph);
  // Tile + the gutters (--space-2 at the start, toward the workspace, and
  // --space-1 at the window edge) + the 1px seam hairline a docked pane adds.
  b.style?.setProperty("--rail-strip-width-right", "calc(var(--rail-icon-size-right) + var(--space-3) + 1px)");
  // Every radius token derives from the one scale in tokens.css. Tokens are
  // declared on :root, so their var(--corner-radius-scale) resolves there too —
  // a scale set on <body> would never reach them. Do not publish a second
  // runtime radius vocabulary here.
  document.documentElement.style?.setProperty("--corner-radius-scale", String(cornerRadiusScale(s.rounding)));
}

/** The radius multiplier a rounding setting publishes. 0..9 is linear
 *  (rounding / 5), so the default 9 (scale 1.8) draws every platform style's
 *  native radii — they divide the scale by 1.8, as the interface styles do.
 *  The last notch is a visible step past native, 1.5× the default, instead of
 *  the +11% a linear scale leaves there (under a millimetre on a 4–8px control). */
export function cornerRadiusScale(rounding: number): number {
  const r = Math.min(10, Math.max(0, rounding));
  return r <= 9 ? r / 5 : Math.round((1.8 + (r - 9) * 0.9) * 100) / 100;
}

export function getUiSettings(): UiSettings {
  return settings;
}

export function setUiSettings(patch: Partial<UiSettings>): void {
  settings = { ...settings, ...patch };
  if (settings.actionGrouping === "ungrouped" && settings.thinkingDisplayMode === "activity") {
    settings.thinkingDisplayMode = "collapsed";
  }
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
export type PreviewableKind = "markdown" | "html" | "json" | "csv" | "svg";
const PREVIEWABLE_KINDS: PreviewableKind[] = ["markdown", "html", "json", "csv", "svg"];

export interface EditorPrefs {
  openInPreview: boolean;
  /** The last preview/edit choice per
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
const editorPrefsListeners = new Set<() => void>();

export function getEditorPrefs(): EditorPrefs {
  return editorPrefs;
}

export function setEditorPrefs(patch: Partial<EditorPrefs>): void {
  editorPrefs = { ...editorPrefs, ...patch };
  try { localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(editorPrefs)); } catch { /* best-effort */ }
  for (const listener of [...editorPrefsListeners]) listener();
}

export function subscribeEditorPrefs(listener: () => void): () => void {
  editorPrefsListeners.add(listener);
  return () => { editorPrefsListeners.delete(listener); };
}

/** Persist the user's preview/edit choice for one previewable kind (the
 *  toolbar switch calls this — programmatic mode flips must not). */
export function setEditorPreviewDefault(kind: PreviewableKind, on: boolean): void {
  setEditorPrefs({ previewByKind: { ...editorPrefs.previewByKind, [kind]: on } });
}
