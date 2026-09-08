import "./styles.css";
import { createElement } from "react";
import { defineWebPackage, type WidgetPlugin } from "@polyth/web-sdk";
import WorkflowLauncher from "./WorkflowLauncher.tsx";
import WorkflowView from "./WorkflowView.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
  }],
};

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: "workflow",
      title: tr("workflowview.workflows"),
      description: tr("capabilities.coordinateAgentRolesInDependencyBasedPipelines"),
      capabilityId: "workflow",
      order: 22,
      component: () => createElement(WorkflowView),
      presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" },
    }),
    host.capabilities.register({
      id: "workflow",
      label: tr("capabilities.workflows"),
      technicalLabel: "DAG orchestration",
      plainDescription: "Coordinate agent roles in dependency-based pipelines.",
      keywords: ["workflow", "dag", "orchestration"],
      standardTier: "more",
      standardRank: 11,
      open: () => host.navigation.openWorkspacePane("workflow"),
      available: () => true,
    }),
    host.widgets.registerPlugin(WORKFLOW_WIDGET_PLUGIN),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
