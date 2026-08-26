import { createElement } from "react";
import { defineWebPackage, type WidgetPlugin } from "@polyth/web-sdk";
import WorkflowLauncher from "./WorkflowLauncher.tsx";
import WorkflowView from "./WorkflowView.tsx";

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
    order: 45,
    render: () => null,
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
      label: "Workflows",
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
