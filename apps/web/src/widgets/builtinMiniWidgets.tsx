import { useState } from "react";
import { formatCombo } from "@polyth/hotkeys";
import { api } from "../api.ts";
import { Icon } from "../icons.tsx";
import { COMPOSER_INPUT_SELECTOR, openWorkspacePane, setOverlay, setUiError, useStore } from "../store.ts";
import { friendlyError } from "../settings.ts";
import { GoalAttachForm } from "../components/GoalStrip.tsx";
import { requestComposerReplace } from "../composerInsert.ts";
import { announce } from "../components/a11y/live.tsx";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";
import { MOD } from "../format.ts";
import { useKeymap } from "../hotkeys.ts";

const SHELL_ACTION_SLOTS = [
  "app.header.actions",
  "session.header.actions",
  "app.nav",
] as const;

const COMPOSER_ACTION_SLOTS = [
  "composer.leading",
  "composer.trailing",
] as const;

function GoalAction({ context }: { context: Record<string, unknown> }) {
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const goalOn = context.goalOn === true;
  const goalBusy = context.goalBusy === true;
  const suppliedToggle = typeof context.toggleGoal === "function"
    ? context.toggleGoal as () => void
    : null;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const activate = () => {
    if (suppliedToggle) {
      suppliedToggle();
      return;
    }
    const draft = document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT_SELECTOR)?.value.trim() ?? "";
    if (!sessionId || !draft) {
      if (sessionId) setOpen(true);
      return;
    }
    setSaving(true);
    void api.goalAttach(sessionId, draft)
      .then(() => {
        requestComposerReplace("");
        announce("Goal attached.");
      })
      .catch((error) => setUiError(friendlyError("Couldn’t attach the goal", error)))
      .finally(() => setSaving(false));
  };
  const label = sessionId
    ? "Save the current message as the goal, or attach a goal"
    : goalOn ? "First message is the goal" : "Use first message as goal";
  return (
    <>
      <button
        className={`header-action composer-goals${goalOn ? " on" : ""}`}
        title={label}
        aria-label={label}
        aria-pressed={!sessionId ? goalOn : undefined}
        disabled={goalBusy || saving}
        onClick={activate}
      >
        <Icon.target /><span>Goal</span>
      </button>
      {open && <GoalAttachForm onDone={() => setOpen(false)} />}
    </>
  );
}

function AutoApproveAction({ context }: { context: Record<string, unknown> }) {
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const session = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === sessionId) ?? null);
  const suppliedToggle = typeof context.toggleAutoApprove === "function"
    ? context.toggleAutoApprove as () => void
    : null;
  const suppliedOn = typeof context.autoApproveOn === "boolean"
    ? context.autoApproveOn
    : undefined;
  const [busy, setBusy] = useState(false);
  const on = suppliedOn ?? session?.autoAccept === true;
  const disabled = context.autoApproveBusy === true || busy;
  const toggle = () => {
    if (suppliedToggle) {
      suppliedToggle();
      return;
    }
    if (!sessionId || disabled) return;
    setBusy(true);
    void api.autoAcceptSet(sessionId, on ? "off" : "on")
      .catch((error) => setUiError(friendlyError("Couldn’t change auto-approve", error)))
      .finally(() => setBusy(false));
  };
  return (
    <button
      className={`header-action composer-auto-approve${on ? " on" : ""}`}
      title={on ? "Turn off auto-approve" : "Turn on auto-approve"}
      aria-label={on ? "Turn off auto-approve" : "Turn on auto-approve"}
      aria-pressed={on}
      disabled={disabled}
      onClick={toggle}
    >
      <Icon.shield /><span>Auto Approve</span>
    </button>
  );
}

function TerminalAction() {
  const keymap = useKeymap();
  const shortcut = formatCombo(keymap.viewTerminal, MOD === "⌘");
  const label = `Open Terminal (${shortcut})`;
  return (
    <button
      className="header-action"
      title={label}
      aria-label={label}
      onClick={() => openWorkspacePane("terminal")}
    >
      <Icon.term /><span>Terminal</span>
    </button>
  );
}

const SHELL_ACTIONS_PLUGIN = defineWidgetPlugin({
  id: "shell-actions",
  name: "Application shell",
  widgets: [
    {
      id: "shell.search",
      title: "Search commands",
      description: "Open commands and actions search.",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 10,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("palette")} aria-label="Search commands and actions">
          <Icon.search /><span>Search</span>
        </button>
      ),
    },
    {
      id: "shell.history",
      title: "Session history",
      description: "Search session history.",
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ["session.header.actions", "app.header.actions"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 20,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("search")} aria-label="Search session history">
          <Icon.clock /><span>History</span>
        </button>
      ),
    },
    {
      id: "shell.settings",
      title: "Settings",
      description: "Open application settings.",
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 30,
      render: () => (
        <button className="header-action" title="Settings" aria-label="Settings" onClick={() => setOverlay("settings")}>
          <Icon.gear /><span>Settings</span>
        </button>
      ),
    },
    {
      id: "session.goal-action",
      title: "Goal",
      description: "Attach a goal, or use the first message as a new session goal.",
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ["session.header.actions"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 30,
      render: (context) => <GoalAction context={context} />,
    },
    {
      id: "session.goal-composer-action",
      title: "Goal",
      description: "Attach a goal, or use the first message as a new session goal.",
      kind: "mini-widget",
      defaultSlot: "composer.leading",
      supportedSlots: COMPOSER_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 30,
      render: (context) => <GoalAction context={context} />,
    },
    {
      id: "permissions.auto-approve-action",
      title: "Auto Approve",
      description: "Toggle automatic approval for the current or next session.",
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ["session.header.actions"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 40,
      render: (context) => <AutoApproveAction context={context} />,
    },
    {
      id: "permissions.auto-approve-composer-action",
      title: "Auto Approve",
      description: "Toggle automatic approval for the current or next session.",
      kind: "mini-widget",
      defaultSlot: "composer.leading",
      supportedSlots: COMPOSER_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 40,
      render: (context) => <AutoApproveAction context={context} />,
    },
  ],
});

const TERMINAL_ACTIONS_PLUGIN = defineWidgetPlugin({
  id: "terminal",
  name: "Terminal",
  widgets: [{
    id: "terminal.open-action",
    title: "Open Terminal",
    description: "Open the project terminal from the application toolbar.",
    kind: "mini-widget",
    defaultSlot: "app.header.actions",
    supportedSlots: SHELL_ACTION_SLOTS,
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 15,
    render: () => <TerminalAction />,
  }],
});

let installed = false;

export function installBuiltinMiniWidgets(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(SHELL_ACTIONS_PLUGIN);
  registerWidgetPlugin(TERMINAL_ACTIONS_PLUGIN);
}
