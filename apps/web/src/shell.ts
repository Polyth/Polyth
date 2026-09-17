import { matchAction, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { getKeymap } from "@polyth/hotkeys/widgets";
import { registerCommand } from "./commands.ts";
import { exportSessionMarkdown, forkSession, abortSession } from "./init.ts";
import { MOD } from "./format.ts";
import {
  focusComposer, getState, openPalette, openWorktreeSessionDialog, setOverlay, startNewSession,
  toggleRailPlugin, toggleWorkspacePane,
  type RailPlugin,
} from "./store.ts";
import {
  getGroupingMode, listGroupings, registerGrouping, setGroupingMode,
  type GroupingDescriptor,
} from "./sidebarPrefs.ts";
import { announce } from "./components/a11y/announce.ts";
import { listCapabilities, subscribeCapabilities, type CapabilityDescriptor } from "./capabilities.ts";
import "./builtinCapabilities.ts";
import { tr } from "./i18n/index.ts";

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

const RAIL = [
  ["context", "capabilities.context"],
  ["knowledge", "capabilities.knowledge"],
  ["usage", "capabilities.usageCost"],
  ["events", "capabilities.eventLog"],
] as const satisfies ReadonlyArray<readonly [RailPlugin, Parameters<typeof tr>[0]]>;

const IS_MAC = MOD === "⌘";
// Live resolver: command hints must always reflect the current custom binding.
const hintOf = (action: HotkeyAction) => (): string => formatCombo(getKeymap()[action], IS_MAC);

/** Register one Group-by palette command for a grouping descriptor. */
function registerGroupingCommand(g: GroupingDescriptor): () => void {
  return registerCommand({
    id: `sidebar.group-by.${g.id}`,
    label: tr("shell.groupSessionsByValue", { label: g.label }),
    group: tr("shell.sidebar"),
    keywords: ["group by", "sidebar", "sort"],
    checked: () => getGroupingMode() === g.id,
    run: () => {
      setGroupingMode(g.id);
      announce(tr("shell.sessionsGroupedByValue", { label: g.label }));
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
    label: terminal ? tr("terminalview.openTerminal") : d.label,
    ...(terminal ? { hint: hintOf("viewTerminal") } : {}),
    group: tr("shell.workspace"),
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
  registerCommand({ id: "cmd.palette", label: tr("shell.commandPalette"), hint: hintOf("palette"), group: tr("shell.shell"), run: () => openPalette("all") });
  registerCommand({
    id: "cmd.searchFiles", label: tr("shell.searchFiles"), hint: hintOf("searchFiles"), group: tr("shell.shell"),
    keywords: ["quick open", "go to file"],
    run: () => openPalette("files"),
  });
  registerCommand({ id: "cmd.search", label: tr("shell.searchSessions"), hint: hintOf("searchSessions"), group: tr("shell.shell"), run: () => setOverlay("search") });
  registerCommand({
    id: "rail.notifications",
    label: tr("notificationcentre.notifications"),
    hint: hintOf("notificationCentre"),
    group: tr("shell.panels"),
    keywords: ["notification centre", "inbox", "bell", "unread"],
    run: () => toggleRailPlugin("slot:notification-centre"),
  });
  registerCommand({ id: "cmd.settings", label: tr("common.settings"), hint: hintOf("settings"), group: tr("shell.shell"), run: () => setOverlay("settings") });
  registerCommand({ id: "cmd.focusComposer", label: tr("shell.focusComposer"), hint: hintOf("focusComposer"), group: tr("shell.shell"), run: focusComposer });
  registerCommand({
    id: "cmd.starterPicker",
    label: tr("mobile.starterpicker.addAStarter"),
    group: tr("shell.session"),
    keywords: ["shortcut", "prompt", "quick action"],
    when: () => {
      const state = getState();
      return state.activeProjectId !== null && state.activeView === "session";
    },
    run: () => setOverlay("starter-picker"),
  });
  registerCommand({
    id: "cmd.new", label: tr("shell.newSession"), hint: hintOf("newSession"), group: tr("shell.session"),
    when: () => !!getState().activeProjectId,
    run: () => { const id = getState().activeProjectId; if (id) startNewSession(id); },
  });
  registerCommand({
    id: "cmd.newWorktree", label: tr("shell.newSessionInWorktree"), group: tr("shell.session"),
    keywords: ["branch", "isolated", "checkout"],
    when: () => !!getState().activeProjectId,
    run: () => {
      const id = getState().activeProjectId;
      if (id) openWorktreeSessionDialog(id);
    },
  });
  registerCommand({
    id: "cmd.fork", label: tr("shell.forkSession"), group: tr("shell.session"),
    when: () => {
      const state = getState();
      return !!state.activeSessionId
        && !state.sessions.find((session) => session.id === state.activeSessionId)?.isolation;
    },
    run: () => { const id = getState().activeSessionId; if (id) void forkSession(id); },
  });
  registerCommand({
    id: "cmd.abort", label: tr("shell.abortCurrentTurn"), group: tr("shell.session"),
    when: () => !!getState().activeSessionId,
    run: () => void abortSession("palette"),
  });
  registerCommand({
    id: "cmd.export", label: tr("shell.exportSession"), group: tr("shell.session"),
    run: exportSessionMarkdown, when: () => !!getState().activeSessionId,
  });
  // Every registered, available capability is searchable regardless of tier.
  syncCapabilityCommands();
  for (const [id, labelKey] of RAIL) {
    registerCommand({
      id: `rail.${id}`, label: tr(labelKey), group: tr("shell.panels"),
      run: () => toggleRailPlugin(id),
    });
  }
  // Sidebar Group by (WP13): built-ins; plugins add via registerSidebarGrouping.
  for (const g of listGroupings()) registerGroupingCommand(g);

  window.addEventListener("keydown", onKey);
}

// Shortcuts call the capability's open() command directly and never check a
// preset — presets change emphasis, not availability.
const ACTIONS: Record<HotkeyAction, () => void> = {
  palette: () => openPalette("all"),
  searchFiles: () => openPalette("files"),
  searchSessions: () => setOverlay("search"),
  notificationCentre: () => toggleRailPlugin("slot:notification-centre"),
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
  // Focused surfaces get first refusal. React handlers run before this window
  // listener while the event bubbles, so a terminal-local shortcut such as
  // Ctrl+Shift+F can prevent the global Session history action.
  if (e.defaultPrevented) return;
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
