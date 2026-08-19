import { matchAction, formatCombo, type HotkeyAction } from "@polyth/hotkeys";
import { registerCommand } from "./commands.ts";
import { createSession, exportSessionMarkdown, forkSession, abortSession } from "./init.ts";
import { MOD } from "./format.ts";
import { PERSONAS, applyPersona, pluginOn, type PersonaId } from "./prefs.ts";
import { getKeymap } from "./hotkeys.ts";
import { readLastReply, stopSpeaking } from "./voice.tsx";
import { getState, setActiveView, setOverlay, toggleRailPlugin, type AppView, type RailPlugin } from "./store.ts";

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
const hintOf = (action: HotkeyAction): string => formatCombo(getKeymap()[action], IS_MAC);

export function focusComposer(): void {
  setActiveView("session");
  // Defer so the composer exists after a view switch.
  setTimeout(() => {
    document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }, 0);
}

export function installShell(): void {
  registerCommand({ id: "cmd.palette", label: "Command palette", hint: hintOf("palette"), group: "Shell", run: () => setOverlay("palette") });
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

  window.addEventListener("keydown", onKey);
}

const ACTIONS: Record<HotkeyAction, () => void> = {
  palette: () => setOverlay("palette"),
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
