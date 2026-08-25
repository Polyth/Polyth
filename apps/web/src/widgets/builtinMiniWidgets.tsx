import { useEffect, useState } from "react";
import type { WorkflowRunDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { Icon } from "../icons.tsx";
import {
  COMPOSER_INPUT_SELECTOR,
  setActiveView,
  setOverlay,
  setUiError,
  useStore,
} from "../store.ts";
import { friendlyError } from "../settings.ts";
import {
  prioritizeWorkflowRuns,
  workflowFinishedCount,
  workflowHumanWait,
} from "../workflowRun.ts";
import { handOffWorkflowLaunch } from "../workflowLaunch.ts";
import { subscribeWorkflowRuns } from "../workflowMonitor.ts";
import { GoalAttachForm } from "../components/GoalStrip.tsx";
import WorkflowLauncher from "../components/WorkflowLauncher.tsx";
import { requestComposerReplace } from "../composerInsert.ts";
import { announce } from "../components/a11y/live.tsx";
import { defineWidgetPlugin, registerWidgetPlugin } from "./catalog.ts";
import { tr } from "../i18n/index.ts";

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
    ? tr("widgets.builtinminiwidgets.saveTheCurrentMessageAsThe")
    : goalOn ? tr("widgets.builtinminiwidgets.firstMessageIsTheGoal") : tr("widgets.builtinminiwidgets.useFirstMessageAsGoal");
  return (
    <>
      <button
        type="button"
        className={`header-action composer-goals${goalOn ? " on" : ""}`}
        title={label}
        aria-label={label}
        aria-pressed={!sessionId ? goalOn : undefined}
        disabled={goalBusy || saving}
        onClick={activate}
      >
        <Icon.target /><span>{tr("widgets.builtinminiwidgets.goal")}</span>
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
      .catch((error) => setUiError(friendlyError(tr("common.error"), error)))
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      className={`header-action composer-auto-approve${on ? " on" : ""}`}
      title={on ? tr("widgets.builtinminiwidgets.turnOffAutoApprove") : tr("widgets.builtinminiwidgets.turnOnAutoApprove")}
      aria-label={on ? tr("widgets.builtinminiwidgets.turnOffAutoApprove") : tr("widgets.builtinminiwidgets.turnOnAutoApprove")}
      aria-pressed={on}
      disabled={disabled}
      onClick={toggle}
    >
      <Icon.shield /><span>{tr("widgets.builtinminiwidgets.autoApprove")}</span>
    </button>
  );
}

function WorkflowAction({ context }: { context: Record<string, unknown> }) {
  return (
    <WorkflowLauncher
      projectId={typeof context.projectId === "string" ? context.projectId : undefined}
      sessionId={typeof context.sessionId === "string" ? context.sessionId : undefined}
      draftText={typeof context.workflowDraftText === "string" ? context.workflowDraftText : ""}
      attachmentCount={typeof context.workflowAttachmentCount === "number" ? context.workflowAttachmentCount : 0}
      consumeDraft={typeof context.consumeWorkflowDraft === "function"
        ? context.consumeWorkflowDraft as () => void
        : () => {}}
    />
  );
}

function WorkflowRunIndicator() {
  const projectId = useStore((state) => state.activeProjectId);
  const [workflowState, setWorkflowState] = useState<{ projectId: string; runs: WorkflowRunDto[] } | null>(null);
  const runs = workflowState && workflowState.projectId === projectId ? workflowState.runs : [];
  const run = runs[0] ?? null;
  useEffect(() => {
    if (!projectId) {
      setWorkflowState(null);
      return;
    }
    setWorkflowState((current) => current?.projectId === projectId ? current : null);
    let active = true;
    const refresh = () => {
      void api.listWorkflowRuns(projectId)
        .then((runs) => {
          if (!active) return;
          const activeRuns = prioritizeWorkflowRuns(runs);
          setWorkflowState(activeRuns.length > 0 ? { projectId, runs: activeRuns } : null);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1_200);
    const unsubscribe = subscribeWorkflowRuns((updated) => {
      if (updated.projectId && updated.projectId !== projectId) return;
      setWorkflowState((current) => {
        const existing = current?.projectId === projectId ? current.runs : [];
        const activeRuns = prioritizeWorkflowRuns([
          updated,
          ...existing.filter((run) => run.id !== updated.id),
        ]);
        return activeRuns.length > 0 ? { projectId, runs: activeRuns } : null;
      });
    });
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [projectId]);
  if (!run || !projectId) return null;
  const done = workflowFinishedCount(run);
  const waits = run.nodes.map(workflowHumanWait);
  const waitingForPermission = waits.includes("permission");
  const waitingForAnswer = waits.includes("answer");
  const actionLabel = waitingForPermission ? "Approval needed" : waitingForAnswer ? "Answer needed" : null;
  const runLabel = runs.length > 1 ? `${runs.length} workflows` : run.name;
  const openRun = () => {
    handOffWorkflowLaunch({
      projectId: run.projectId ?? projectId,
      ...(run.parentSessionId ? { sessionId: run.parentSessionId } : {}),
      workflowId: run.workflowId,
      input: run.input,
      run,
    });
    setActiveView("workflow");
  };
  return (
    <button
      type="button"
      className={`header-action workflow-run-indicator${actionLabel ? " waiting" : ""}`}
      title={actionLabel ? `Workflow action required: ${actionLabel.toLowerCase()}` : "Open active workflow"}
      aria-label={`${actionLabel ?? runLabel}, ${done} of ${run.nodes.length} nodes finished. Open workflow`}
      onClick={openRun}
    >
      <span className="workflow-status-spinner" aria-hidden="true" />
      <span aria-live="polite">{actionLabel ?? `${runLabel} ${done}/${run.nodes.length}`}</span>
    </button>
  );
}

export const WORKFLOW_WIDGET_PLUGIN = defineWidgetPlugin({
  id: "workflow",
  name: "Workflows",
  widgets: [{
    id: "workflow.composer-action",
    title: "Workflows",
    description: "Choose a workflow and run the current draft, or open the builder.",
    kind: "mini-widget",
    defaultSlot: "composer.trailing",
    supportedSlots: COMPOSER_ACTION_SLOTS,
    defaultVisible: true,
    requiredVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 50,
    render: (context) => <WorkflowAction context={context} />,
  }, {
    id: "workflow.active-run",
    title: "Active workflow",
    description: "Show active workflow progress and approval needs in the session header.",
    kind: "mini-widget",
    defaultSlot: "session.header.actions",
    supportedSlots: ["session.header.actions", "app.header.actions"],
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 45,
    render: () => <WorkflowRunIndicator />,
  }],
});

const SHELL_ACTIONS_PLUGIN = defineWidgetPlugin({
  id: "shell-actions",
  name: tr("widgets.builtinminiwidgets.applicationShell"),
  widgets: [
    {
      id: "shell.search",
      title: tr("widgets.builtinminiwidgets.searchCommands"),
      description: tr("widgets.builtinminiwidgets.openCommandsAndActionsSearch"),
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 10,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("palette")} aria-label={tr("widgets.builtinminiwidgets.searchCommandsAndActions")}>
          <Icon.search /><span>{tr("common.search")}</span>
        </button>
      ),
    },
    {
      id: "shell.history",
      title: tr("widgets.builtinminiwidgets.sessionHistory"),
      description: tr("widgets.builtinminiwidgets.searchSessionHistory"),
      kind: "mini-widget",
      defaultSlot: "session.header.actions",
      supportedSlots: ["session.header.actions", "app.header.actions"],
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 20,
      render: () => (
        <button className="header-action" onClick={() => setOverlay("search")} aria-label={tr("widgets.builtinminiwidgets.searchSessionHistory2")}>
          <Icon.clock /><span>{tr("widgets.builtinminiwidgets.history")}</span>
        </button>
      ),
    },
    {
      id: "shell.settings",
      title: tr("common.settings"),
      description: tr("widgets.builtinminiwidgets.openApplicationSettings"),
      kind: "mini-widget",
      defaultSlot: "app.header.actions",
      supportedSlots: SHELL_ACTION_SLOTS,
      defaultVisible: true,
      defaultSize: { w: 1, h: 1 },
      resizable: false,
      audience: "simple",
      order: 30,
      render: () => (
        <button className="header-action" title={tr("common.settings")} aria-label={tr("common.settings")} onClick={() => setOverlay("settings")}>
          <Icon.gear /><span>{tr("common.settings")}</span>
        </button>
      ),
    },
    {
      id: "session.goal-action",
      title: tr("widgets.builtinminiwidgets.goal"),
      description: tr("widgets.builtinminiwidgets.attachAGoalOrUseTheFirst"),
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
      title: tr("widgets.builtinminiwidgets.goal"),
      description: tr("widgets.builtinminiwidgets.attachAGoalOrUseTheFirst"),
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
      title: tr("widgets.builtinminiwidgets.autoApprove"),
      description: tr("widgets.builtinminiwidgets.toggleAutomaticApprovalForTheCurrentOr"),
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
      title: tr("widgets.builtinminiwidgets.autoApprove"),
      description: tr("widgets.builtinminiwidgets.toggleAutomaticApprovalForTheCurrentOr"),
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

let installed = false;

export function installBuiltinMiniWidgets(): void {
  if (installed) return;
  installed = true;
  registerWidgetPlugin(SHELL_ACTIONS_PLUGIN);
  registerWidgetPlugin(WORKFLOW_WIDGET_PLUGIN);
}
