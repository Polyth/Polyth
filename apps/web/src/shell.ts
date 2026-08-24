import { HOTKEY_ACTIONS, matchAction, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { registerCommand } from "./commands.ts";
import { exportSessionMarkdown, forkSession, abortSession } from "./init.ts";
import { MOD } from "./format.ts";
import { getKeymap } from "./hotkeys.ts";
import { readLastReply, stopSpeaking } from "./voice.tsx";
import {
  focusComposer, getState, openPalette, openSettingsPage, openWorktreeSessionDialog, setOverlay, startNewSession,
  toggleRailPlugin, toggleWorkspacePane,
  type RailPlugin,
} from "./store.ts";
import {
  getGroupingMode, listGroupings, registerGrouping, setGroupingMode,
  type GroupingDescriptor,
} from "./sidebarPrefs.ts";
import { announce } from "./components/a11y/live.tsx";
import { listCapabilities, subscribeCapabilities, type CapabilityDescriptor } from "./capabilities.ts";
import "./builtinCapabilities.ts";

/** Old palette labels preserved as extra search terms per capability so
 *  existing users' muscle memory ("Git & worktrees", "Fuse models") keeps
 *  finding the same commands. */
const LEGACY_SEARCH_TERMS: Record<string, string[]> = {
  session: ["Open session"],
  files: ["Files & editor"],
  goals: ["Open goals"],
  multirun: ["Compare models"],
  fusion: ["Fuse models"],
  preview: ["Live preview"],
  git: ["Git & worktrees"],
  schedule: ["Scheduled prompts"],
  github: ["GitHub issues & PRs"],
};

const RAIL: Array<[RailPlugin, string]> = [
  ["context", "Context panel"], ["knowledge", "Knowledge panel"],
  ["usage", "Usage panel"], ["events", "Event log"],
];

const IS_MAC = MOD === "⌘";
// Live resolver: command hints must always reflect the current custom binding.
const hintOf = (action: HotkeyAction) => (): string => formatCombo(getKeymap()[action], IS_MAC);

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

/** One palette command per capability descriptor: same id, same open()
 *  command as the header, rail, compact Tools, Settings, and shortcuts.
 *  Search matches plain and technical terms; shortcuts never check a preset. */
function capabilityCommand(d: CapabilityDescriptor): () => void {
  const terminal = d.id === "terminal";
  return registerCommand({
    id: `capability.${d.id}`,
    label: terminal ? "Open Terminal" : d.label,
    ...(terminal ? { hint: hintOf("viewTerminal") } : {}),
    group: "Workspace",
    keywords: [
      ...(d.technicalLabel ? [d.technicalLabel] : []),
      ...d.keywords,
      ...(LEGACY_SEARCH_TERMS[d.id] ?? []),
      d.plainDescription,
    ],
    when: d.available,
    run: d.open,
  });
}

/** Keep palette commands in lockstep with the capability registry: a
 *  dynamically registered extension is searchable immediately; a disposed one
 *  vanishes with its descriptor. */
function syncCapabilityCommands(): () => void {
  const disposers = new Map<string, () => void>();
  const sync = () => {
    const current = new Map(listCapabilities().map((d) => [d.id, d]));
    for (const [id, dispose] of disposers) {
      if (!current.has(id)) {
        dispose();
        disposers.delete(id);
      }
    }
    for (const [id, d] of current) {
      disposers.get(id)?.();
      disposers.set(id, capabilityCommand(d));
    }
  };
  sync();
  const unsubscribe = subscribeCapabilities(sync);
  return () => {
    unsubscribe();
    for (const dispose of disposers.values()) dispose();
    disposers.clear();
  };
}

export function installShell(): void {
  registerCommand({ id: "cmd.palette", label: "Command palette", hint: hintOf("palette"), group: "Shell", run: () => openPalette("all") });
  registerCommand({
    id: "cmd.searchFiles", label: "Search files", hint: hintOf("searchFiles"), group: "Shell",
    keywords: ["quick open", "go to file"],
    run: () => openPalette("files"),
  });
  registerCommand({ id: "cmd.search", label: "Search sessions", hint: hintOf("searchSessions"), group: "Shell", run: () => setOverlay("search") });
  registerCommand({ id: "cmd.settings", label: "Settings", hint: hintOf("settings"), group: "Shell", run: () => setOverlay("settings") });
  registerCommand({ id: "cmd.focusComposer", label: "Focus composer", hint: hintOf("focusComposer"), group: "Shell", run: focusComposer });
  registerCommand({
    id: "cmd.new", label: "New session", hint: hintOf("newSession"), group: "Session",
    when: () => !!getState().activeProjectId,
    run: () => { const id = getState().activeProjectId; if (id) startNewSession(id); },
  });
  registerCommand({
    id: "cmd.newWorktree", label: "New session in worktree", group: "Session",
    keywords: ["branch", "isolated", "checkout"],
    when: () => !!getState().activeProjectId,
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
    when: () => !!getState().activeSessionId,
    run: readLastReply,
  });
  registerCommand({
    id: "voice.stop", label: "Stop reading aloud", group: "Voice",
    run: stopSpeaking,
  });
  // Every registered, available capability is searchable regardless of tier.
  syncCapabilityCommands();
  for (const [id, label] of RAIL) {
    registerCommand({
      id: `rail.${id}`, label, group: "Panels",
      run: () => toggleRailPlugin(id),
    });
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

// Shortcuts call the capability's open() command directly and never check a
// preset — presets change emphasis, not availability.
const ACTIONS: Record<HotkeyAction, () => void> = {
  palette: () => openPalette("all"),
  searchFiles: () => openPalette("files"),
  searchSessions: () => setOverlay("search"),
  settings: () => setOverlay("settings"),
  newSession: () => {
    const id = getState().activeProjectId;
    if (id) startNewSession(id);
  },
  focusComposer,
  // Workspace-pane shortcuts toggle so the same keys also close (and remain
  // reachable from inside a focused terminal without sending it Escape).
  viewFiles: () => toggleWorkspacePane("files"),
  viewGit: () => toggleWorkspacePane("git"),
  viewTerminal: () => toggleWorkspacePane("terminal"),
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
