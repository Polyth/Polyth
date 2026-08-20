import { HOTKEY_ACTIONS, matchAction, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { registerCommand } from "./commands.ts";
import { createSession, exportSessionMarkdown, forkSession, abortSession } from "./init.ts";
import { MOD } from "./format.ts";
import { PERSONAS, applyPersona, pluginOn, type PersonaId } from "./prefs.ts";
import { getKeymap } from "./hotkeys.ts";
import { readLastReply, stopSpeaking } from "./voice.tsx";
import {
  getState, openPalette, openSettingsPage, openWorktreeSessionDialog, setActiveView, setOverlay, toggleRailPlugin,
  type AppView, type RailPlugin,
} from "./store.ts";
import {
  getGroupingMode, listGroupings, registerGrouping, setGroupingMode,
  type GroupingDescriptor,
} from "./sidebarPrefs.ts";
import { announce } from "./components/a11y/live.tsx";

const VIEW: Array<[AppView, string]> = [
  ["session", "Open session"], ["files", "Files & editor"], ["goals", "Open goals"], ["multirun", "Compare models"],
  ["fusion", "Fuse models"], ["walkthrough", "Guided walkthrough"], ["preview", "Live preview"],
  ["git", "Git & worktrees"], ["terminal", "Terminal"], ["schedule", "Scheduled prompts"], ["github", "GitHub issues & PRs"],
];
const RAIL: Array<[RailPlugin, string]> = [
  ["files", "Files panel"], ["changes", "Changes panel"], ["context", "Context panel"],
  ["usage", "Usage panel"], ["events", "Event log"],
];

const IS_MAC = MOD === "⌘";
// Live resolver: command hints must always reflect the current custom binding.
const hintOf = (action: HotkeyAction) => (): string => formatCombo(getKeymap()[action], IS_MAC);

export function focusComposer(): void {
  setActiveView("session");
  // Defer so the composer exists after a view switch.
  setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }, 0);
}

/** Register one Group-by palette command for a grouping descriptor. */
function registerGroupingCommand(g: GroupingDescriptor): () => void {
  return registerCommand({
    id: `sidebar.group-by.${g.id}`,
    label: `Group sessions by: ${g.label}`,
    group: "Sidebar",
    keywords: ["group by", "sidebar", "sort"],
    checked: () => getGroupingMode() === g.id,
    run: () => {
      setGroupingMode(g.id);
      announce(`Sessions grouped by ${g.label}`);
    },
  });
}

/** Plugin entry point: contribute a sidebar grouping + its palette command. */
export function registerSidebarGrouping(desc: GroupingDescriptor): () => void {
  const disposeGrouping = registerGrouping(desc);
  const disposeCommand = registerGroupingCommand(desc);
  return () => {
    disposeCommand();
    disposeGrouping();
    // If the removed mode was active, getGroupingMode() already falls back.
  };
}

export function installShell(): void {
  registerCommand({ id: "cmd.palette", label: "Command palette", hint: hintOf("palette"), group: "Shell", run: () => openPalette("all") });
  registerCommand({
    id: "cmd.searchFiles", label: "Search files", hint: hintOf("searchFiles"), group: "Shell",
    keywords: ["quick open", "go to file"],
    when: () => pluginOn("files"),
    run: () => openPalette("files"),
  });
  registerCommand({ id: "cmd.search", label: "Search sessions", hint: hintOf("searchSessions"), group: "Shell", run: () => setOverlay("search") });
  registerCommand({ id: "cmd.settings", label: "Settings", hint: hintOf("settings"), group: "Shell", run: () => setOverlay("settings") });
  registerCommand({ id: "cmd.customize", label: "Customize workspace", group: "Shell", run: () => setOverlay("onboarding") });
  registerCommand({ id: "cmd.focusComposer", label: "Focus composer", hint: hintOf("focusComposer"), group: "Shell", run: focusComposer });
  registerCommand({
    id: "cmd.new", label: "New session", hint: hintOf("newSession"), group: "Session",
    when: () => !!getState().activeProjectId,
    run: () => { const id = getState().activeProjectId; if (id) void createSession(id); },
  });
  registerCommand({
    id: "cmd.newWorktree", label: "New session in worktree", group: "Session",
    keywords: ["branch", "isolated", "checkout"],
    when: () => !!getState().activeProjectId && pluginOn("git"),
    run: () => {
      const id = getState().activeProjectId;
      if (id) openWorktreeSessionDialog(id);
    },
  });
  registerCommand({
    id: "cmd.fork", label: "Fork session", group: "Session",
    when: () => !!getState().activeSessionId,
    run: () => { const id = getState().activeSessionId; if (id) void forkSession(id); },
  });
  registerCommand({
    id: "cmd.abort", label: "Abort current turn", group: "Session",
    when: () => !!getState().activeSessionId,
    run: () => void abortSession(),
  });
  registerCommand({
    id: "cmd.export", label: "Export session", group: "Session",
    run: exportSessionMarkdown, when: () => !!getState().activeSessionId,
  });
  registerCommand({
    id: "voice.read", label: "Read last reply aloud", group: "Voice",
    when: () => pluginOn("dictation") && !!getState().activeSessionId,
    run: readLastReply,
  });
  registerCommand({
    id: "voice.stop", label: "Stop reading aloud", group: "Voice",
    when: () => pluginOn("dictation"),
    run: stopSpeaking,
  });
  for (const [view, label] of VIEW) {
    registerCommand({
      id: `view.${view}`, label, group: "Views",
      when: () => pluginOn(view),
      run: () => setActiveView(view),
    });
  }
  for (const [id, label] of RAIL) {
    registerCommand({
      id: `rail.${id}`, label, group: "Panels",
      when: () => pluginOn(id === "changes" ? "git" : id),
      run: () => toggleRailPlugin(id),
    });
  }
  for (const id of Object.keys(PERSONAS) as PersonaId[]) {
    registerCommand({ id: `persona.${id}`, label: `Persona: ${PERSONAS[id].label}`, group: "Workspace", run: () => applyPersona(id) });
  }
  // Sidebar Group by (WP13): built-ins; plugins add via registerSidebarGrouping.
  for (const g of listGroupings()) registerGroupingCommand(g);
  // Searchable shortcut editing: one row per action, hint shows the binding,
  // matching also works on the key itself ("ctrl+k" finds the palette row).
  for (const { id, label } of HOTKEY_ACTIONS) {
    registerCommand({
      id: `shortcut.${id}`,
      label: `Change shortcut: ${label}`,
      group: "Shortcuts",
      keywords: ["keybinding", "hotkey", "shortcut"],
      hint: hintOf(id),
      run: () => openSettingsPage("shortcuts"),
    });
  }

  window.addEventListener("keydown", onKey);
}

const ACTIONS: Record<HotkeyAction, () => void> = {
  palette: () => openPalette("all"),
  searchFiles: () => { if (pluginOn("files")) openPalette("files"); },
  searchSessions: () => setOverlay("search"),
  settings: () => setOverlay("settings"),
  newSession: () => {
    const id = getState().activeProjectId;
    if (id) void createSession(id);
  },
  focusComposer,
  viewFiles: () => { if (pluginOn("files")) setActiveView("files"); },
  viewGit: () => { if (pluginOn("git")) setActiveView("git"); },
  viewTerminal: () => { if (pluginOn("terminal")) setActiveView("terminal"); },
};

function onKey(e: KeyboardEvent): void {
  // IME composition keydowns (incl. legacy keyCode 229) never trigger shortcuts.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Escape") { setOverlay(null); return; }
  // The Shortcuts editor captures the next keydown itself.
  if ((e.target as HTMLElement | null)?.closest?.("[data-hotkey-capture]")) return;
  const action = matchAction(getKeymap(), e);
  if (!action) return;
  // Plain-key combos (no mod) must not fire while typing.
  const mod = e.metaKey || e.ctrlKey;
  const el = e.target as HTMLElement | null;
  const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  if (!mod && typing) return;
  e.preventDefault();
  ACTIONS[action]();
}
