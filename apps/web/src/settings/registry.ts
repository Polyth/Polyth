// Item-level settings registry (WP9). Every built-in settings row registers a
// searchable descriptor; plugin pages may add items through their slot props.
// Search is diacritic-insensitive and groups hits by page; the view routes to
// the page then focuses/flashes the exact row via its focusTarget.

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
  { id: "projects.canvas", pageId: "projects", label: "Project canvas setup", description: "Per-project starting arrangement and widgets", keywords: ["preset", "starting setup", "workspace", "canvas"], focusTarget: "projects.canvas" },
  { id: "appearance.theme", pageId: "appearance", label: "Theme", description: "Search bundled, system, and custom color themes", keywords: ["appearance", "dark", "light", "palette", "colors"], focusTarget: "appearance.theme" },
  { id: "appearance.fontFamily", pageId: "appearance", label: "Interface font", keywords: ["typeface", "system", "serif", "sans", "mono"], focusTarget: "appearance.fontFamily" },
  { id: "appearance.density", pageId: "appearance", label: "Density", keywords: ["compact", "balanced", "comfortable", "spacing"], focusTarget: "appearance.density" },
  { id: "appearance.fontSize", pageId: "appearance", label: "Font size", keywords: ["text", "scale"], focusTarget: "appearance.fontSize" },
  { id: "appearance.editorFontSize", pageId: "appearance", label: "Editor font size", description: "Composer, file editor, diffs, terminal, and code blocks", keywords: ["monospace", "code", "px"], focusTarget: "appearance.editorFontSize" },
  { id: "appearance.rounding", pageId: "appearance", label: "Corner rounding", keywords: ["square", "rounded", "radius", "corners"], focusTarget: "appearance.rounding" },
  { id: "appearance.menuItems", pageId: "appearance", label: "Menu items", description: "Optional composer and workspace actions", keywords: ["technical", "dictation", "quick actions", "toolbar"], focusTarget: "appearance.menuItems" },
  { id: "chat.width", pageId: "chat", label: "Conversation width", keywords: ["wide", "layout"], focusTarget: "chat.width" },
  { id: "chat.followUp", pageId: "chat", label: "While the agent is working", description: "Steer, queue, or interrupt", keywords: ["delivery", "steer", "queue", "interrupt"], focusTarget: "chat.followUp" },
  { id: "chat.thinking", pageId: "chat", label: "Thinking blocks", keywords: ["reasoning", "collapse"], focusTarget: "chat.thinking" },
  { id: "chat.messageActions", pageId: "chat", label: "Message actions", description: "Show or hide Copy, Revert, and Fork controls", keywords: ["hover", "quick actions", "buttons"], focusTarget: "chat.messageActions" },
  { id: "chat.copyFormat", pageId: "chat", label: "Copy format", description: "Copy messages as Markdown or JSON", keywords: ["clipboard", "markdown", "json"], focusTarget: "chat.copyFormat" },
  { id: "notifications.desktop", pageId: "notifications", label: "Desktop notification", keywords: ["alert", "browser"], focusTarget: "notifications.desktop" },
  { id: "notifications.sound", pageId: "notifications", label: "Completion sound", keywords: ["beep", "audio"], focusTarget: "notifications.sound" },
  { id: "behavior.confirmArchive", pageId: "behavior", label: "Confirm before archiving sessions", keywords: ["archive", "safety"], focusTarget: "behavior.confirmArchive" },
  { id: "behavior.autosave", pageId: "behavior", label: "Editor autosave", keywords: ["save", "revision"], focusTarget: "behavior.autosave" },
  { id: "behavior.instructions", pageId: "behavior", label: "Global instructions", description: "Behavior text applied to every agent (global AGENTS.md)", keywords: ["agents.md", "system prompt", "rules"], focusTarget: "behavior.instructions" },
  { id: "widgets.capabilities", pageId: "widgets", label: "Workspace button places", description: "Arrange tools in the Focus header, More tools, and Technical menu", keywords: ["zones", "header", "rail", "buttons", "placement", "hide"], focusTarget: "widgets.capabilities" },
  { id: "widgets.actions", pageId: "widgets", label: "Composer and header actions", description: "Show or hide composer, session header, and app header buttons", keywords: ["composer", "actions", "mini widgets", "toolbar"], focusTarget: "widgets.actions" },
  { id: "about.info", pageId: "about", label: "Application URL", description: "Server address, data directory, and capabilities", keywords: ["about", "version", "health", "url"], focusTarget: "about.info" },
  { id: "sessions.defaultModel", pageId: "sessions", label: "Global default model", description: "Default model for new sessions and projects", keywords: ["session", "provider", "model"], focusTarget: "sessions.defaultModel" },
  { id: "sessions.projectModel", pageId: "sessions", label: "Project default model", description: "Per-project model override", keywords: ["session", "project", "inherit", "global"], focusTarget: "sessions.projectModel" },
  { id: "git.personas", pageId: "git", label: "Git personas", description: "Repository-local commit author identities", keywords: ["author", "email", "identity"], focusTarget: "git.personas" },
  { id: "sessions.worktree", pageId: "sessions", label: "Worktree behavior", keywords: ["session", "fresh worktree", "project root"], focusTarget: "sessions.worktree" },
];

registerSettingsItems(BUILTIN_ITEMS);
