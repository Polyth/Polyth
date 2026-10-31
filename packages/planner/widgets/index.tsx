import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { CalendarIcon } from "../../../apps/web/src/components/ui/index.ts";
import { PLANNER_PACKAGE_ID } from "../src/packageId.ts";
import PlannerView from "./PlannerView.tsx";
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
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
