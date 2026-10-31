// Item-level settings registry. Every built-in settings row registers a
// searchable descriptor; plugin pages may add items through their slot props.
// Search is diacritic-insensitive and groups hits by page; the view routes to
// the page then focuses/flashes the exact row via its focusTarget.
import { tr } from "../i18n/index.ts";
import { assertOwnerCanReplace } from "../packages/ownership.ts";

export interface SettingsSearchItem {
  id: string;
  pageId: string;
  label: string;
  description?: string;
  keywords?: string[];
  /** data-settings-item value of the row to focus. */
  focusTarget: string;
  ownerPackageId?: string;
}

export interface SettingsSearchHit {
  item: SettingsSearchItem;
  pageLabel: string;
}

/** Fold case + diacritics so "Résumé" matches "resume". */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const registry = new Map<string, SettingsSearchItem>();

/** Register items. Same-owner replacement is allowed; cross-owner collisions
 *  throw. Unregister is identity-safe so a stale disposer cannot delete a
 *  newer item. */
export function registerSettingsItems(items: SettingsSearchItem[]): () => void {
  const registrations: SettingsSearchItem[] = [];
  for (const item of items) {
    const existing = registry.get(item.id);
    if (existing) {
      assertOwnerCanReplace({
        registry: "settings search item",
        id: item.id,
        existingOwner: existing.ownerPackageId,
        nextOwner: item.ownerPackageId,
      });
    }
    registry.set(item.id, item);
    registrations.push(item);
  }
  return () => {
    for (const item of registrations) {
      if (registry.get(item.id) === item) registry.delete(item.id);
    }
  };
}

export function listSettingsItems(): SettingsSearchItem[] {
  return [...registry.values()];
}

/** Page-level synonyms so a whole page is findable by the words people use
 *  for it ("password" → Credential Vault) even when its rows register no
 *  item descriptors. Host-curated for first-party page ids; matched together
 *  with the page title. */
export const SETTINGS_PAGE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  general: ["language", "locale", "startup", "preferences"],
  appearance: ["theme", "dark", "light", "mode", "color", "font", "text size", "density", "wallpaper", "background", "glass"],
  chat: ["conversation", "message", "composer", "paste", "metrics"],
  notifications: ["alerts", "sound", "desktop notification", "badge"],
  sessions: ["default model", "history", "archive", "walkthrough"],
  projects: ["folder", "repository", "repo", "workspace", "remove project"],
  behavior: ["system prompt", "instructions", "agent", "permissions"],
  permissions: ["full access", "auto-approve", "approvals", "yolo", "dangerous"],
  packages: ["plugins", "extensions", "install", "add-ons"],
  users: ["accounts", "people", "members", "invite"],
  about: ["version", "build", "license"],
  voice: ["dictation", "speech", "microphone", "transcription", "tts", "elevenlabs"],
  usage: ["limits", "quota", "tokens", "cost", "billing", "rate limit"],
  harnesses: ["opencode", "claude", "codex", "runtime", "providers", "models", "api key"],
  mcp: ["model context protocol", "tools", "servers"],
  skills: ["instructions", "agent skills"],
  commands: ["slash", "snippets", "prompts"],
  judgment: ["evaluation", "review", "verify", "grader"],
  "custom-titles": ["session title", "rename", "naming"],
  todos: ["tasks", "checklist", "to-do"],
  files: ["editor", "code editor", "inline ai"],
  git: ["source control", "commit", "branch", "github", "gitlab", "pull request"],
  ssh: ["remote", "server", "host", "key"],
  "task-trackers": ["jira", "trello", "linear", "issues", "tickets"],
  monitoring: ["logs", "metrics", "system", "health", "admin"],
  browser: ["web", "page", "auto-approve", "preview"],
  "web-search": ["internet", "search engine", "tavily", "duckduckgo"],
  "secure-safe": ["password", "secret", "token", "api key", "credential", "vault"],
  tunnel: ["phone", "mobile", "pair", "device", "qr", "remote access"],
  shortcuts: ["hotkeys", "keyboard", "keybindings"],
  "home-assistant": ["smart home", "devices"],
  // "prompt assist" stays as the old name people may still search for.
  recap: ["session assist", "prompt assist", "rewrite", "improve prompt"],
};

/** Pages whose title or curated synonyms match. Ordered: title prefix match,
 *  then title substring, then synonym-only matches. */
export function searchSettingsPages<P extends { id: string; label: string }>(
  query: string,
  pages: readonly P[],
): P[] {
  const q = fold(query.trim());
  if (!q) return [];
  const ranked: { page: P; rank: number }[] = [];
  for (const page of pages) {
    const title = fold(page.label);
    const rank = title.startsWith(q)
      ? 0
      : title.includes(q)
        ? 1
        : (SETTINGS_PAGE_KEYWORDS[page.id] ?? []).some((word) => fold(word).includes(q))
          ? 2
          : -1;
    if (rank >= 0) ranked.push({ page, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.page.label.localeCompare(b.page.label))
    .map((entry) => entry.page);
}

export function searchSettingsItems(
  query: string,
  pageLabels: Record<string, string>,
): SettingsSearchHit[] {
  const q = fold(query.trim());
  if (!q) return [];
  const hits: SettingsSearchHit[] = [];
  for (const item of registry.values()) {
    const hay = [item.label, item.description ?? "", ...(item.keywords ?? [])].map(fold);
    if (!hay.some((h) => h.includes(q))) continue;
    // Items on pages the current build doesn't show (disposed plugin, hidden
    // capability) are skipped rather than leading to a dead click.
    const pageLabel = pageLabels[item.pageId];
    if (!pageLabel) continue;
    hits.push({ item, pageLabel });
  }
  hits.sort((a, b) => a.pageLabel.localeCompare(b.pageLabel) || a.item.label.localeCompare(b.item.label));
  return hits.slice(0, 40);
}

// ---- built-in item descriptors ---------------------------------------------------

const BUILTIN_ITEMS: SettingsSearchItem[] = [
  { id: "general.language", pageId: "general", label: tr("settings.registry.language"), description: tr("settings.registry.interfaceLanguageAndRegionalFormatting"), keywords: ["locale", "translation", "rtl"], focusTarget: "general.language" },
  { id: "appearance.style", pageId: "appearance", label: tr("settings.registry.themeStyle"), description: tr("settings.registry.themeStyleDescription"), keywords: ["platform", "style", "theme", "macos", "liquid glass", "big sur", "windows", "fluent", "polyth", "classic", "design", "controls"], focusTarget: "appearance.style" },
  { id: "appearance.theme", pageId: "appearance", label: tr("settings.registry.theme"), description: tr("settings.registry.searchBundledSystemAndCustomColorThemes"), keywords: ["appearance", "dark", "light", "palette", "colors", "color scheme"], focusTarget: "appearance.theme" },
  { id: "appearance.accent", pageId: "appearance", label: tr("settings.registry.accentColor"), description: tr("settings.registry.accentColorDescription"), keywords: ["accent", "highlight", "selection", "tint", "color"], focusTarget: "appearance.accent" },
  { id: "appearance.shellLook", pageId: "appearance", label: tr("settings.pages.shellLook"), description: tr("settings.pages.shellLookHint"), keywords: ["look", "style", "interface style", "skin", "layout", "design", "glass", "wallpaper", "paper", "line", "air", "monolith", "obsidian", "editorial", "premium", "minimal", "serif"], focusTarget: "appearance.shellLook" },
  { id: "appearance.background", pageId: "appearance", label: tr("settings.pages.workspaceBackground"), description: tr("settings.registry.workspaceBackgroundDescription"), keywords: ["wallpaper", "image", "glass", "gradient"], focusTarget: "appearance.background" },
  { id: "appearance.glass", pageId: "appearance", label: tr("settings.pages.glassSurfaces"), description: tr("settings.pages.glassSurfacesHint"), keywords: ["glass", "blur", "transparency", "matte", "clear", "effects"], focusTarget: "appearance.glass" },
  { id: "appearance.topRailSurface", pageId: "appearance", label: tr("settings.pages.topRailSurface"), description: tr("settings.registry.topBarStyleDescription"), keywords: ["header", "top rail", "shadow", "flat", "floating", "bar", "divider", "border", "menu", "icons"], focusTarget: "appearance.topRailSurface" },
  { id: "appearance.windowLayout", pageId: "appearance", label: tr("settings.shellLayout.title"), description: tr("settings.shellLayout.hint"), keywords: ["layout", "window", "full height", "columns", "sidebar", "top bar", "header", "hide header", "island", "floating", "bare", "panel", "rail"], focusTarget: "appearance.windowLayout" },
  { id: "appearance.mirrorLayout", pageId: "appearance", label: tr("settings.pages.mirrorLayout"), description: tr("settings.pages.mirrorLayoutHint"), keywords: ["mirror", "layout", "sidebar", "right", "left", "ide", "side"], focusTarget: "appearance.mirrorLayout" },
  { id: "appearance.railSpacing", pageId: "appearance", label: tr("settings.pages.railSpacing"), description: tr("settings.pages.railSpacingHint"), keywords: ["rail", "icons", "gap", "spacing", "padding", "launcher", "sidebar", "toolbar", "px"], focusTarget: "appearance.railSpacing" },
  { id: "appearance.compactShortcuts", pageId: "appearance", label: tr("settings.pages.compactShortcuts"), description: tr("settings.pages.compactShortcutsHint"), keywords: ["tablet", "ipad", "shortcuts", "toolbar", "header", "top bar", "icons", "pin", "order", "more"], focusTarget: "appearance.compactShortcuts" },
  { id: "appearance.textSize", pageId: "appearance", label: tr("settings.pages.textSize"), description: tr("settings.pages.textSizeHint"), keywords: ["text", "font", "size", "bigger", "smaller", "zoom", "scale", "px"], focusTarget: "appearance.textSize" },
  { id: "appearance.fontFamily", pageId: "appearance", label: tr("settings.registry.interfaceFont"), keywords: ["typeface", "system", "serif", "sans", "mono"], focusTarget: "appearance.fontFamily" },
  { id: "appearance.density", pageId: "appearance", label: tr("settings.registry.density"), keywords: ["compact", "balanced", "comfortable", "spacing"], focusTarget: "appearance.density" },
  { id: "appearance.chatFontSize", pageId: "appearance", label: tr("settings.pages.chatTextSize"), description: tr("settings.pages.chatTextSizeHint"), keywords: ["chat", "message", "conversation", "transcript", "composer", "text", "px"], focusTarget: "appearance.chatFontSize" },
  { id: "appearance.fontSize", pageId: "appearance", label: tr("settings.pages.menuTextSize"), description: tr("settings.pages.menuTextSizeHint"), keywords: ["text", "menu", "labels", "sidebar", "session", "worktree", "navigator", "scale"], focusTarget: "appearance.fontSize" },
  { id: "appearance.headerFontSize", pageId: "appearance", label: tr("settings.pages.headerSize"), keywords: ["heading", "title", "text", "px"], focusTarget: "appearance.headerFontSize" },
  { id: "appearance.subheaderFontSize", pageId: "appearance", label: tr("settings.pages.subheaderSize"), keywords: ["subheading", "project", "navigator", "text", "px"], focusTarget: "appearance.subheaderFontSize" },
  { id: "appearance.terminalFontSize", pageId: "appearance", label: tr("settings.registry.terminalFontSize"), description: tr("settings.registry.terminalInputAndOutput"), keywords: ["terminal", "monospace", "console", "px"], focusTarget: "appearance.terminalFontSize" },
  { id: "appearance.editorFontSize", pageId: "appearance", label: tr("settings.registry.editorFontSize"), description: tr("settings.registry.editorFontSizeDescription"), keywords: ["editor", "composer", "code", "px"], focusTarget: "appearance.editorFontSize" },
  { id: "appearance.railSizes", pageId: "appearance", label: tr("settings.pages.railSizes"), description: tr("settings.pages.railSizeHint"), keywords: ["rail", "icons", "size", "compact", "large", "sidebar", "toolbar", "launcher"], focusTarget: "appearance.railSizes" },
  { id: "appearance.rounding", pageId: "appearance", label: tr("settings.registry.cornerRounding"), keywords: ["square", "rounded", "radius", "corners"], focusTarget: "appearance.rounding" },
  { id: "general.swipeNavigation", pageId: "general", label: tr("settings.pages.swipeNavigation"), description: tr("settings.pages.swipeNavigationHint"), keywords: ["swipe", "gesture", "gestures", "phone", "mobile", "navigator", "navigation", "widgets", "tools", "back", "edge", "drawer"], focusTarget: "general.swipeNavigation" },
  { id: "appearance.statusBar", pageId: "appearance", label: tr("settings.pages.statusBar"), description: tr("settings.pages.statusBarHint"), keywords: ["statusbar", "status bar", "bottom bar", "footer", "branch", "model", "workflow", "widgets"], focusTarget: "appearance.statusBar" },
  { id: "chat.showDictate", pageId: "chat", label: tr("settings.pages.dictationButton"), description: tr("settings.pages.dictationButtonHint"), keywords: ["dictation", "voice", "microphone", "mic", "speech", "composer", "button"], focusTarget: "chat.showDictate" },
  { id: "chat.showQuickActions", pageId: "chat", label: tr("settings.pages.composerQuickActions"), description: tr("settings.pages.composerQuickActionsHint"), keywords: ["quick actions", "composer", "toolbar", "buttons", "technical"], focusTarget: "chat.showQuickActions" },
  { id: "chat.width", pageId: "chat", label: tr("settings.registry.conversationWidth"), keywords: ["wide", "layout"], focusTarget: "chat.width" },
  { id: "chat.followUp", pageId: "chat", label: tr("settings.registry.whileTheAgentIsWorking"), description: tr("settings.registry.steerQueueOrInterrupt"), keywords: ["delivery", "steer", "queue", "interrupt"], focusTarget: "chat.followUp" },
  { id: "chat.largePaste", pageId: "chat", label: tr("composer.largePasteBanner"), description: tr("settings.pages.largePasteHint"), keywords: ["paste", "clipboard", "attach", "inline", "large"], focusTarget: "chat.largePaste" },
  { id: "chat.actionBlocks", pageId: "chat", label: tr("settings.pages.actionBlocks"), description: tr("settings.pages.groupActionsIntoActivityBlocksOrKeepThemUngrouped"), keywords: ["actions", "tools", "tasks", "grouped", "ungrouped", "activity"], focusTarget: "chat.actionBlocks" },
  { id: "chat.thinking", pageId: "chat", label: tr("settings.registry.thinkingBlocks"), keywords: ["reasoning", "collapse", "expanded", "hidden"], focusTarget: "chat.thinking" },
  { id: "chat.activityStyle", pageId: "chat", label: tr("settings.pages.activityBlockStyle"), description: tr("settings.pages.activityBlockStyleHint"), keywords: ["activity", "block", "thread", "ledger", "chip", "margin", "style", "look"], focusTarget: "chat.activityStyle" },
  { id: "chat.composerStatusStyle", pageId: "chat", label: tr("settings.pages.composerStatusStyle"), description: tr("settings.pages.composerStatusStyleHint"), keywords: ["status", "agent", "edited", "files", "composer", "line", "tab", "capsule", "style"], focusTarget: "chat.composerStatusStyle" },
  { id: "chat.activityDetails", pageId: "chat", label: tr("settings.pages.sessionActivityDetails"), description: tr("settings.pages.sessionActivityDetailsHint"), keywords: ["activity", "session", "stats", "tokens", "plan", "tabs"], focusTarget: "chat.activityDetails" },
  { id: "chat.mobileSessionTitle", pageId: "chat", label: tr("settings.pages.mobileSessionTitle"), description: tr("settings.pages.mobileSessionTitleHint"), keywords: ["mobile", "phone", "session", "title", "header", "glass", "button", "transparent", "hidden"], focusTarget: "chat.mobileSessionTitle" },
  { id: "chat.messageActions", pageId: "chat", label: tr("settings.quickActions.userTitle"), description: tr("settings.quickActions.userHint"), keywords: ["hover", "quick actions", "buttons", "menu", "copy", "revert", "fork", "message actions"], focusTarget: "chat.messageActions" },
  { id: "chat.promptNavigator", pageId: "chat", label: tr("settings.pages.promptRail"), description: tr("settings.pages.promptRailHint"), keywords: ["prompt", "rail", "navigator", "history", "ticks", "disable", "hide"], focusTarget: "chat.promptNavigator" },
  { id: "chat.pinLatestPrompt", pageId: "chat", label: tr("settings.pages.promptBookmarkMobile"), description: tr("settings.pages.promptBookmarkMobileHint"), keywords: ["bookmark", "peek", "prompt", "scroll", "jump", "mobile", "phone"], focusTarget: "chat.pinLatestPrompt" },
  { id: "chat.promptBookmarkDesktop", pageId: "chat", label: tr("settings.pages.promptBookmarkDesktop"), description: tr("settings.pages.promptBookmarkDesktopHint"), keywords: ["bookmark", "peek", "prompt", "scroll", "jump", "desktop", "wide"], focusTarget: "chat.promptBookmarkDesktop" },
  { id: "chat.pinLatestPromptPosition", pageId: "chat", label: tr("settings.pages.pinLatestPromptPosition"), description: tr("timeline.promptBookmarkMoveHint"), keywords: ["bookmark", "prompt", "drag", "move", "position", "reset", "handed"], focusTarget: "chat.pinLatestPromptPosition" },
  { id: "chat.promptNavigatorSide", pageId: "chat", label: tr("settings.pages.promptNavigatorSide"), description: tr("settings.pages.promptNavigatorSideHint"), keywords: ["prompt", "rail", "navigator", "history", "left", "right", "side", "ticks"], focusTarget: "chat.promptNavigatorSide" },
  { id: "chat.headerMetrics", pageId: "chat", label: tr("settings.pages.chatMetrics"), description: tr("settings.registry.chatMetricsDescription"), keywords: ["tokens", "duration", "cost", "header"], focusTarget: "chat.headerMetrics" },
  { id: "chat.responseActions", pageId: "chat", label: tr("settings.quickActions.assistantTitle"), description: tr("settings.quickActions.assistantHint"), keywords: ["pin", "new session", "regenerate", "copy", "buttons", "hover", "tap", "menu", "answer actions"], focusTarget: "chat.responseActions" },
  { id: "chat.copyFormat", pageId: "chat", label: tr("settings.registry.copyFormat"), description: tr("settings.registry.copyMessagesAsMarkdownOrJson"), keywords: ["clipboard", "markdown", "json"], focusTarget: "chat.copyFormat" },
  { id: "chat.mobileSendShortcut", pageId: "chat", label: tr("settings.pages.mobileSendShortcut"), keywords: ["mobile", "phone", "enter", "shift", "send"], focusTarget: "chat.mobileSendShortcut" },
  { id: "chat.promptHistory", pageId: "chat", label: tr("settings.registry.promptHistory"), description: tr("settings.pages.promptHistoryHint"), keywords: ["history", "arrow", "prompts", "recall", "composer", "space"], focusTarget: "chat.promptHistory" },
  { id: "chat.promptHistoryLimit", pageId: "chat", label: tr("settings.registry.promptHistoryLimit"), description: tr("settings.pages.promptHistoryLimitHint"), keywords: ["history", "limit", "recall", "prompts"], focusTarget: "chat.promptHistoryLimit" },
  { id: "notifications.desktop", pageId: "notifications", label: tr("settings.registry.desktopNotification"), keywords: ["alert", "browser"], focusTarget: "notifications.desktop" },
  { id: "notifications.sound", pageId: "notifications", label: tr("settings.registry.completionSound"), keywords: ["beep", "audio"], focusTarget: "notifications.sound" },
  { id: "notifications.centreHistory", pageId: "notifications", label: tr("settings.registry.centreHistory"), description: tr("settings.registry.keepReadNotificationsVisibleInTheNotification"), keywords: ["inbox", "bell", "read", "notification centre"], focusTarget: "notifications.centreHistory" },
  { id: "behavior.confirmArchive", pageId: "behavior", label: tr("settings.registry.confirmBeforeArchivingSessions"), keywords: ["archive", "safety"], focusTarget: "behavior.confirmArchive" },
  { id: "behavior.autosave", pageId: "behavior", label: tr("settings.registry.editorAutosave"), keywords: ["save", "revision"], focusTarget: "behavior.autosave" },
  { id: "behavior.sharedPinnedWindow", pageId: "behavior", label: tr("settings.pages.sharedPinnedWindow"), description: tr("settings.pages.sharedPinnedWindowHint"), keywords: ["pin", "pinned", "window", "size", "width", "dock", "package"], focusTarget: "behavior.sharedPinnedWindow" },
  { id: "behavior.favoriteSubagents", pageId: "behavior", label: tr("settings.pages.favoriteSubagents"), description: tr("settings.registry.favoriteSubagentsDescription"), keywords: ["delegate", "spawn", "retry", "agent"], focusTarget: "behavior.favoriteSubagents" },
  { id: "behavior.instructions", pageId: "behavior", label: tr("settings.registry.globalInstructions"), description: tr("settings.registry.behaviorTextAppliedToEveryAgentGlobal"), keywords: ["agents.md", "system prompt", "rules"], focusTarget: "behavior.instructions" },
  { id: "behavior.workspaceInstructions", pageId: "behavior", label: tr("settings.pages.workspaceInstructions"), description: tr("settings.registry.workspaceInstructionsDescription"), keywords: ["agents.md", "workspace", "repository", "prompt", "harness"], focusTarget: "behavior.workspaceInstructions" },
  { id: "users.manage", pageId: "users", label: tr("settingsview.users"), description: tr("settings.registry.usersDescription"), keywords: ["people", "accounts", "members", "roles", "permissions", "access"], focusTarget: "users.manage" },
  { id: "users.sharing", pageId: "users", label: tr("sharing.policyTitle"), description: tr("sharing.policyHint"), keywords: ["share", "sharing", "private", "visibility", "people", "access", "space"], focusTarget: "users.sharing" },
  { id: "about.info", pageId: "about", label: tr("settings.registry.applicationUrl"), description: tr("settings.registry.serverAddressDataDirectoryAndCapabilities"), keywords: ["about", "version", "health", "url"], focusTarget: "about.info" },
  { id: "sessions.defaultModel", pageId: "sessions", label: tr("settings.registry.globalDefaultModel"), description: tr("settings.registry.defaultModelForNewSessionsAndProjects"), keywords: ["session", "provider", "model"], focusTarget: "sessions.defaultModel" },
  { id: "sessions.defaultVisibleSessionCount", pageId: "sessions", label: tr("settings.sessionspage.defaultVisibleSessions"), description: tr("settings.sessionspage.defaultVisibleSessionsHint"), keywords: ["session", "navigator", "loaded", "default", "performance"], focusTarget: "sessions.defaultVisibleSessionCount" },
  { id: "sessions.autoDeleteFailedStartupSessions", pageId: "sessions", label: tr("settings.sessionspage.autoDeleteFailedStartupSessions"), description: tr("settings.sessionspage.autoDeleteFailedStartupSessionsHint"), keywords: ["session", "startup", "failure", "delete", "cleanup"], focusTarget: "sessions.autoDeleteFailedStartupSessions" },
  { id: "projects.interface", pageId: "projects", label: tr("projectcomposition.interfaceTitle"), description: tr("projectcomposition.interfaceHint"), keywords: ["shared", "same", "all projects", "per project", "separate", "layout", "rail", "buttons", "widgets", "tabs", "interface", "directions"], focusTarget: "projects.interface" },
  { id: "projects.appearance", pageId: "projects", label: tr("projectappearancedialog.projectAppearance"), keywords: ["project", "name", "icon", "color", "appearance"], focusTarget: "projects.appearance" },
  { id: "projects.canvas", pageId: "projects", label: tr("settings.pages.projectCanvas"), description: tr("settings.pages.projectCanvasHint"), keywords: ["project", "canvas", "widgets", "workspace", "tab", "header"], focusTarget: "projects.canvas" },
  { id: "projects.executionHarness", pageId: "projects", label: tr("settings.pages.defaultHarness"), description: tr("settings.pages.overridesTheGlobalDefaultForNewSessions"), keywords: ["project", "harness", "runtime", "execution", "new", "chat"], focusTarget: "projects.executionHarness" },
  { id: "projects.defaultModel", pageId: "projects", label: tr("settings.registry.projectDefaultModel"), description: tr("settings.pages.overridesTheGlobalDefaultForNewSessions"), keywords: ["project", "model", "provider", "default", "new", "chat"], focusTarget: "projects.defaultModel" },
  { id: "projects.modelMemory", pageId: "projects", label: tr("settings.registry.rememberProjectModelSelection"), description: tr("settings.registry.useTheLastSelectedModelForNew"), keywords: ["session", "project", "model", "default", "memory"], focusTarget: "projects.modelMemory" },
  { id: "projects.isolation", pageId: "projects", label: tr("settings.pages.isolationLevel"), description: tr("settings.pages.isolationLevelHint"), keywords: ["session", "project", "isolate", "isolation", "worktree", "git", "sandbox", "environment", "virtualization"], focusTarget: "projects.isolation" },
  { id: "sessions.worktree", pageId: "sessions", label: tr("settings.registry.worktreeBehavior"), keywords: ["session", "fresh worktree", "project root"], focusTarget: "sessions.worktree" },
];

registerSettingsItems(BUILTIN_ITEMS);
