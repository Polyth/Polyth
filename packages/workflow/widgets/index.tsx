import "./styles.css";
import "./chat.css";
import "./statusbar.css";
import { createElement } from "react";
import type { HarnessSelection, ModelRef, SessionEvent } from "@polyth/contracts";
import { defineWebPackage, type MessageActionSlotMeta, type WidgetPlugin, type WidgetRenderContext } from "@polyth/web-sdk";
import WorkflowLauncher from "./WorkflowLauncher.tsx";
import WorkflowMessageAction, { workflowMessageActionAvailable } from "./WorkflowMessageAction.tsx";
import WorkflowSessionBadge from "./WorkflowSessionBadge.tsx";
import { requestWorkflowLauncher } from "./WorkflowLauncher.tsx";
import WorkflowTimelineEvent from "./WorkflowTimelineEvent.tsx";
import WorkflowView from "./WorkflowView.tsx";
import WorkflowStatusbarSegment from "./WorkflowStatusbarSegment.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { WorkflowIcon } from "../../../apps/web/src/components/ui/index.ts";

export const WORKFLOW_WIDGET_PLUGIN: WidgetPlugin = {
  id: "workflow",
  name: tr("workflowview.workflows"),
  widgets: [{
    id: "workflow.composer-action",
    title: tr("workflowview.workflows"),
    description: tr("workflowview.widget.description"),
    kind: "mini-widget",
    defaultSlot: "composer.trailing",
    // Acts on the agent's turn: hidden where the composer writes only to people.
    agentOnly: true,
    supportedSlots: ["composer.leading", "composer.trailing"],
    defaultVisible: true,
    defaultSize: { w: 1, h: 1 },
    resizable: false,
    audience: "simple",
    order: 50,
    render: (context) => createElement(WorkflowLauncher, {
      projectId: typeof context.projectId === "string" ? context.projectId : undefined,
      spaceId: typeof context.spaceId === "string" ? context.spaceId : undefined,
      sessionId: typeof context.sessionId === "string" ? context.sessionId : undefined,
      draftText: typeof context.workflowDraftText === "string" ? context.workflowDraftText : "",
      workflowAttachments: Array.isArray(context.workflowAttachments)
        ? context.workflowAttachments
        : [],
      workflowBusy: context.workflowBusy === true,
      model: context.workflowModel as ModelRef | undefined,
      harness: context.workflowHarness as HarnessSelection | undefined,
      agent: typeof context.workflowAgent === "string" ? context.workflowAgent : undefined,
      attachmentCount: typeof context.workflowAttachmentCount === "number"
        ? context.workflowAttachmentCount
        : 0,
      consumeDraft: typeof context.consumeWorkflowDraft === "function"
        ? context.consumeWorkflowDraft as (expectedText?: string) => boolean | void
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
      component: () => createElement(WorkflowView, {
        // Reuse the composer's own harness picker; the package only supplies
        // the route context the composer picker already understands.
        harnessSlot: (context) => createElement(host.ui.Slot, { slot: "modelPicker.header", context }),
      }),
      presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" },
    }),
    host.capabilities.register({
      id: "workflow",
      label: tr("capabilities.workflows"),
      technicalLabel: tr("workflowview.technicalLabel"),
      plainDescription: tr("capabilities.coordinateAgentRolesInDependencyBasedPipelines"),
      keywords: ["workflow", "dag", "orchestration"],
      standardTier: "more",
      standardRank: 11,
      defaultRails: { general: "right", engineering: "right", research: "right", operations: "top" },
      open: () => host.navigation.openWorkspacePane("workflow"),
      available: () => true,
    }),
    host.widgets.registerPlugin(WORKFLOW_WIDGET_PLUGIN),
    // The status bar is arranged exactly like every other widget area. The
    // segment, its run poll and its strip frame live here: the shell names no
    // workflow UI. `statusbarStrip` lets the minimal activity strip render it
    // without cluster chrome while a run is active.
    host.widgets.registerPlugin({
      id: "workflow-statusbar",
      name: tr("statusbar.label"),
      widgets: [{
        id: "statusbar.workflow",
        title: tr("statusbar.widgetWorkflow"),
        description: tr("statusbar.widgetWorkflowHint"),
        kind: "mini-widget",
        defaultSlot: "app.statusbar.leading",
        supportedSlots: ["app.statusbar.leading", "app.statusbar.trailing"],
        defaultVisible: true,
        // A run waiting on the user must stay reachable: it can move to the
        // other end of the bar but never be hidden from it.
        requiredVisible: true,
        statusbarStrip: true,
        defaultSize: { w: 1, h: 1 },
        resizable: false,
        audience: "simple",
        order: 70,
        render: (context: WidgetRenderContext) => createElement(WorkflowStatusbarSegment, {
          host,
          projectId: typeof context.projectId === "string" ? context.projectId : null,
          strip: context.strip === true,
        }),
      }],
    }),
    host.slots.register({
      slot: "session.timeline.event",
      id: "workflow.timeline-card",
      order: 20,
      meta: { eventTypes: ["workflow/run-started"] },
      render: (props) => createElement(WorkflowTimelineEvent, {
        host,
        event: props.event as SessionEvent,
        sessionId: (typeof props.sessionId === "string" && props.sessionId)
          || (props.event as SessionEvent).sessionId,
      }),
    }),
    host.slots.register({
      slot: "session.message.actions",
      id: "workflow.message-launcher",
      order: 35,
      render: (props) => createElement(WorkflowMessageAction, props),
      meta: {
        messageAction: {
          label: () => tr("workflowlauncher.runInWorkflow"),
          description: () => tr("workflowlauncher.chooseWorkflowRun"),
          icon: WorkflowIcon,
          menu: true,
          available: workflowMessageActionAvailable,
        } satisfies MessageActionSlotMeta,
      },
    }),
    host.slots.register({
      slot: "session.list.badges",
      id: "workflow.session-badge",
      order: 30,
      render: (props) => createElement(WorkflowSessionBadge, {
        sessionId: typeof props.sessionId === "string" ? props.sessionId : "",
      }),
    }),
    host.slots.register({
      slot: "commandPalette.commands",
      id: "workflow.launcher-command",
      order: 35,
      render: () => null,
      meta: {
        commands: [{
          id: "workflow.launcher",
          label: tr("workflowview.runWorkflow"),
          group: tr("workflowview.workflows"),
          run: () => {
            const snapshot = host.store.getSnapshot();
            requestWorkflowLauncher({
              projectId: snapshot.activeProjectId ?? undefined,
              sessionId: snapshot.activeSessionId ?? undefined,
            });
          },
        }],
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
