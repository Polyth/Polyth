import "./styles.css";
import { createElement, useEffect, useState } from "react";
import type { WorkflowRunDto } from "@polyth/contracts";
import { defineWebPackage, type WidgetPlugin } from "@polyth/web-sdk";
import { api } from "@polyth/session/web-api";
import WorkflowLauncher from "./WorkflowLauncher.tsx";
import WorkflowView from "./WorkflowView.tsx";
import { setActiveView, useStore } from "../../../apps/web/src/store.ts";
import {
  prioritizeWorkflowRuns,
  workflowFinishedCount,
  workflowHumanWait,
} from "./workflowRun.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { subscribeWorkflowRuns } from "./workflowMonitor.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

function WorkflowRunIndicator() {
  const projectId = useStore((state) => state.activeProjectId);
  const [workflowState, setWorkflowState] = useState<{
    projectId: string;
    runs: WorkflowRunDto[];
  } | null>(null);
  const runs = workflowState?.projectId === projectId ? workflowState.runs : [];
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
        .then((nextRuns) => {
          if (!active) return;
          const prioritized = prioritizeWorkflowRuns(nextRuns);
          setWorkflowState(prioritized.length > 0
            ? { projectId, runs: prioritized }
            : null);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1_200);
    const unsubscribe = subscribeWorkflowRuns((updated) => {
      if (updated.projectId && updated.projectId !== projectId) return;
      setWorkflowState((current) => {
        const existing = current?.projectId === projectId ? current.runs : [];
        const prioritized = prioritizeWorkflowRuns([
          updated,
          ...existing.filter((candidate) => candidate.id !== updated.id),
        ]);
        return prioritized.length > 0 ? { projectId, runs: prioritized } : null;
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
  const actionLabel = waits.includes("permission")
    ? "Approval needed"
    : waits.includes("answer") ? "Answer needed" : null;
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
  return createElement("button", {
    type: "button",
    className: `header-action workflow-run-indicator${actionLabel ? " waiting" : ""}`,
    title: actionLabel
      ? `Workflow action required: ${actionLabel.toLowerCase()}`
      : "Open active workflow",
    "aria-label": `${actionLabel ?? runLabel}, ${done} of ${run.nodes.length} nodes finished. Open workflow`,
    onClick: openRun,
  },
  createElement("span", { className: "workflow-status-spinner", "aria-hidden": true }),
  createElement("span", { "aria-live": "polite" }, actionLabel ?? `${runLabel} ${done}/${run.nodes.length}`));
}

export const WORKFLOW_WIDGET_PLUGIN: WidgetPlugin = {
  id: "workflow",
  name: "Workflows",
  widgets: [{
    id: "workflow.composer-action",
    title: "Workflows",
    description: "Choose a workflow and run the current draft.",
    kind: "mini-widget",
    defaultSlot: "composer.trailing",
    supportedSlots: ["composer.leading", "composer.trailing"],
    defaultVisible: true,
    requiredVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 50,
    render: (context) => createElement(WorkflowLauncher, {
      projectId: typeof context.projectId === "string" ? context.projectId : undefined,
      sessionId: typeof context.sessionId === "string" ? context.sessionId : undefined,
      draftText: typeof context.workflowDraftText === "string" ? context.workflowDraftText : "",
      attachmentCount: typeof context.workflowAttachmentCount === "number"
        ? context.workflowAttachmentCount
        : 0,
      consumeDraft: typeof context.consumeWorkflowDraft === "function"
        ? context.consumeWorkflowDraft as () => void
        : () => {},
    }),
  }, {
    id: "workflow.active-run",
    title: "Active workflow",
    description: "Show active workflow progress in the session header.",
    kind: "mini-widget",
    defaultSlot: "session.header.actions",
    supportedSlots: ["session.header.actions", "app.header.actions"],
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 45,
    render: () => createElement(WorkflowRunIndicator),
  }],
};

export default defineWebPackage((host) => () => {
  const off = [
    host.workspaceSurfaces.register({
      id: "workflow",
      title: "Workflows",
      order: 22,
      plugin: "workflow",
      requires: "project",
      component: () => createElement(WorkflowView),
    }),
    host.capabilities.register({
      id: "workflow",
      label: tr("capabilities.workflows"),
      technicalLabel: "DAG orchestration",
      plainDescription: "Coordinate agent roles in dependency-based pipelines.",
      keywords: ["workflow", "dag", "orchestration"],
      standardTier: "more",
      standardRank: 11,
      open: () => host.navigation.setActiveView("workflow"),
      available: () => true,
    }),
    host.widgets.registerPlugin(WORKFLOW_WIDGET_PLUGIN),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
