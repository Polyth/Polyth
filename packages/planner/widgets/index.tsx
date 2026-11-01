import "./styles.css";
import type { SessionEvent } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { CalendarIcon } from "../../../apps/web/src/components/ui/index.ts";
import { PLANNER_RUN_STARTED_EVENT } from "../src/model.ts";
import { PLANNER_PACKAGE_ID } from "../src/packageId.ts";
import { ChatScheduleLine, PlannedRunFact } from "./ChatSchedule.tsx";
import PlannerView from "./PlannerView.tsx";
import { connectPlannerTasks } from "./plannerTasks.ts";
import { t } from "./plannerText.ts";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: PLANNER_PACKAGE_ID,
      title: t("title"),
      description: t("description"),
      capabilityId: PLANNER_PACKAGE_ID,
      order: 26,
      component: ({ projectId }) => <PlannerView host={host} projectId={projectId ?? null} />,
      presentation: {
        kind: "workspace",
        defaultRatio: 0.72,
        minWidth: 360,
        minHeight: 240,
        preferredMaxWidth: 1040,
        keepAlive: true,
        escape: "close",
        dock: "bottom",
        dockOptions: ["bottom", "side"],
      },
    }),
    host.capabilities.register({
      id: PLANNER_PACKAGE_ID,
      label: t("title"),
      plainDescription: t("description"),
      keywords: ["planner", "plan", "planned", "schedule", "scheduled prompt", "recurring", "cron", "reminder", "планувальник", "розклад"],
      icon: CalendarIcon,
      standardTier: "more",
      standardRank: 15,
      defaultRails: { general: "right", engineering: "right", research: "right", operations: "top", home: "top", wellbeing: "top", finance: "top", personal: "right" },
      open: () => host.navigation.openWorkspacePane(PLANNER_PACKAGE_ID),
      available: () => true,
    }),
    host.widgets.registerPlugin({
      id: PLANNER_PACKAGE_ID,
      name: t("title"),
      widgets: [{
        id: `${PLANNER_PACKAGE_ID}.main`,
        title: t("title"),
        description: t("description"),
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main", "workspace.bottom"],
        defaultSize: { w: 12, h: 6 },
        render: ({ projectId }) => <PlannerView host={host} projectId={projectId} />,
      }],
    }),
    // The chat's own schedule: one line above the composer while runs are
    // planned to arrive in it, just above a watched pull request's line.
    host.slots.register({
      slot: "session.composer.before",
      id: "planner.chat-schedule",
      order: 890,
      meta: { title: t("chat.title") },
      render: (props) => <ChatScheduleLine
        key={typeof props.sessionId === "string" ? props.sessionId : "none"}
        host={host}
        sessionId={typeof props.sessionId === "string" ? props.sessionId : null}
      />,
    }),
    // Where each planned run arrived, just before the prompt it sent.
    host.slots.register({
      slot: "session.timeline.event",
      id: "planner.run-fact",
      order: 30,
      meta: { eventTypes: [PLANNER_RUN_STARTED_EVENT] },
      render: (props) => <PlannedRunFact host={host} event={props.event as SessionEvent} />,
    }),
    connectPlannerTasks(host),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
