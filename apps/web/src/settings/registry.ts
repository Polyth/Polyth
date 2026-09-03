// Item-level settings registry (WP9). Every built-in settings row registers a
// searchable descriptor; plugin pages may add items through their slot props.
// Search is diacritic-insensitive and groups hits by page; the view routes to
// the page then focuses/flashes the exact row via its focusTarget.
import { tr } from "../i18n/index.ts";

export interface SettingsSearchItem {
  id: string;
  pageId: string;
  label: string;
  description?: string;
  keywords?: string[];
  /** data-settings-item value of the row to focus. */
  focusTarget: string;
}

export interface SettingsSearchHit {
  item: SettingsSearchItem;
  pageLabel: string;
}

/** Fold case + diacritics so "Résumé" matches "resume". */
export const fold = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const registry = new Map<string, SettingsSearchItem>();

/** Register items; duplicate ids overwrite (last registration wins) so a
 *  reloaded plugin never doubles its rows. Returns an unregister function. */
export function registerSettingsItems(items: SettingsSearchItem[]): () => void {
  const ids = items.map((i) => i.id);
  for (const item of items) registry.set(item.id, item);
  return () => {
    for (const id of ids) registry.delete(id);
  };
}

export function listSettingsItems(): SettingsSearchItem[] {
  return [...registry.values()];
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
  { id: "projects.canvas", pageId: "projects", label: tr("settings.registry.projectCanvasSetup"), description: tr("settings.registry.perProjectStartingArrangementAndWidgets"), keywords: ["preset", "starting setup", "workspace", "canvas"], focusTarget: "projects.canvas" },
  { id: "appearance.theme", pageId: "appearance", label: tr("settings.registry.theme"), description: tr("settings.registry.searchBundledSystemAndCustomColorThemes"), keywords: ["appearance", "dark", "light", "palette", "colors"], focusTarget: "appearance.theme" },
  { id: "appearance.fontFamily", pageId: "appearance", label: tr("settings.registry.interfaceFont"), keywords: ["typeface", "system", "serif", "sans", "mono"], focusTarget: "appearance.fontFamily" },
  { id: "appearance.density", pageId: "appearance", label: tr("settings.registry.density"), keywords: ["compact", "balanced", "comfortable", "spacing"], focusTarget: "appearance.density" },
  { id: "appearance.fontSize", pageId: "appearance", label: "General text size", description: "Chat, inputs, session titles, and settings", keywords: ["text", "body", "chat", "scale"], focusTarget: "appearance.fontSize" },
  { id: "appearance.headerFontSize", pageId: "appearance", label: "Header size", keywords: ["heading", "title", "text", "px"], focusTarget: "appearance.headerFontSize" },
  { id: "appearance.subheaderFontSize", pageId: "appearance", label: "Subheader size", keywords: ["project", "worktree", "navigator", "text", "px"], focusTarget: "appearance.subheaderFontSize" },
  { id: "appearance.terminalFontSize", pageId: "appearance", label: tr("settings.registry.terminalFontSize"), description: tr("settings.registry.terminalInputAndOutput"), keywords: ["terminal", "monospace", "console", "px"], focusTarget: "appearance.terminalFontSize" },
  { id: "appearance.editorFontSize", pageId: "appearance", label: tr("settings.registry.editorFontSize"), description: "Composer, file editor, diffs, and code blocks", keywords: ["editor", "composer", "code", "px"], focusTarget: "appearance.editorFontSize" },
  { id: "appearance.rounding", pageId: "appearance", label: tr("settings.registry.cornerRounding"), keywords: ["square", "rounded", "radius", "corners"], focusTarget: "appearance.rounding" },
  { id: "appearance.menuItems", pageId: "appearance", label: tr("settings.registry.menuItems"), description: tr("settings.registry.optionalComposerAndWorkspaceActions"), keywords: ["technical", "dictation", "quick actions", "toolbar"], focusTarget: "appearance.menuItems" },
  { id: "chat.width", pageId: "chat", label: tr("settings.registry.conversationWidth"), keywords: ["wide", "layout"], focusTarget: "chat.width" },
  { id: "chat.followUp", pageId: "chat", label: tr("settings.registry.whileTheAgentIsWorking"), description: tr("settings.registry.steerQueueOrInterrupt"), keywords: ["delivery", "steer", "queue", "interrupt"], focusTarget: "chat.followUp" },
  { id: "chat.thinking", pageId: "chat", label: tr("settings.registry.thinkingBlocks"), keywords: ["reasoning", "collapse"], focusTarget: "chat.thinking" },
  { id: "chat.messageActions", pageId: "chat", label: tr("settings.registry.messageActions"), description: tr("settings.registry.showOrHideCopyRevertAndFork"), keywords: ["hover", "quick actions", "buttons"], focusTarget: "chat.messageActions" },
  { id: "chat.headerMetrics", pageId: "chat", label: "Chat metrics", description: "Choose metrics shown in the chat header", keywords: ["tokens", "duration", "cost", "header"], focusTarget: "chat.headerMetrics" },
  { id: "chat.responseActions", pageId: "chat", label: "Answer quick actions", description: "Choose buttons shown on agent answers", keywords: ["pin", "new session", "fork", "copy", "buttons"], focusTarget: "chat.responseActions" },
  { id: "chat.copyFormat", pageId: "chat", label: tr("settings.registry.copyFormat"), description: tr("settings.registry.copyMessagesAsMarkdownOrJson"), keywords: ["clipboard", "markdown", "json"], focusTarget: "chat.copyFormat" },
  { id: "chat.mobileSendShortcut", pageId: "chat", label: tr("settings.pages.mobileSendShortcut"), keywords: ["mobile", "phone", "enter", "shift", "send"], focusTarget: "chat.mobileSendShortcut" },
  { id: "notifications.desktop", pageId: "notifications", label: tr("settings.registry.desktopNotification"), keywords: ["alert", "browser"], focusTarget: "notifications.desktop" },
  { id: "notifications.sound", pageId: "notifications", label: tr("settings.registry.completionSound"), keywords: ["beep", "audio"], focusTarget: "notifications.sound" },
  { id: "notifications.centreHistory", pageId: "notifications", label: tr("settings.registry.centreHistory"), description: tr("settings.registry.keepReadNotificationsVisibleInTheNotification"), keywords: ["inbox", "bell", "read", "notification centre"], focusTarget: "notifications.centreHistory" },
  { id: "behavior.confirmArchive", pageId: "behavior", label: tr("settings.registry.confirmBeforeArchivingSessions"), keywords: ["archive", "safety"], focusTarget: "behavior.confirmArchive" },
  { id: "behavior.autosave", pageId: "behavior", label: tr("settings.registry.editorAutosave"), keywords: ["save", "revision"], focusTarget: "behavior.autosave" },
  { id: "behavior.favoriteSubagents", pageId: "behavior", label: "Require favorite subagents", description: "Choose the best favorite instead of inheriting the parent model", keywords: ["delegate", "spawn", "retry", "agent"], focusTarget: "behavior.favoriteSubagents" },
  { id: "behavior.instructions", pageId: "behavior", label: tr("settings.registry.globalInstructions"), description: tr("settings.registry.behaviorTextAppliedToEveryAgentGlobal"), keywords: ["agents.md", "system prompt", "rules"], focusTarget: "behavior.instructions" },
  { id: "widgets.capabilities", pageId: "widgets", label: tr("settings.registry.workspaceButtonPlaces"), description: tr("settings.registry.arrangeToolsInTheCenteredChat"), keywords: ["zones", "header", "rail", "buttons", "placement", "hide"], focusTarget: "widgets.capabilities" },
  { id: "widgets.actions", pageId: "widgets", label: tr("settings.registry.composerAndHeaderActions"), description: tr("settings.registry.showOrHideComposerSessionHeaderAnd"), keywords: ["composer", "actions", "mini widgets", "toolbar"], focusTarget: "widgets.actions" },
  { id: "about.info", pageId: "about", label: tr("settings.registry.applicationUrl"), description: tr("settings.registry.serverAddressDataDirectoryAndCapabilities"), keywords: ["about", "version", "health", "url"], focusTarget: "about.info" },
  { id: "sessions.defaultModel", pageId: "sessions", label: tr("settings.registry.globalDefaultModel"), description: tr("settings.registry.defaultModelForNewSessionsAndProjects"), keywords: ["session", "provider", "model"], focusTarget: "sessions.defaultModel" },
  { id: "projects.modelMemory", pageId: "projects", label: tr("settings.registry.rememberProjectModelSelection"), description: tr("settings.registry.useTheLastSelectedModelForNew"), keywords: ["session", "project", "model", "default", "memory"], focusTarget: "projects.modelMemory" },
  { id: "sessions.worktree", pageId: "sessions", label: tr("settings.registry.worktreeBehavior"), keywords: ["session", "fresh worktree", "project root"], focusTarget: "sessions.worktree" },
];

registerSettingsItems(BUILTIN_ITEMS);
