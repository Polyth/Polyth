import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import PlannerView from "./PlannerView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: "schedule",
      title: "Planner",
      capabilityId: "schedule",
      order: 25,
      component: () => createElement(PlannerView),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.72,
        minWidth: 380,
        minHeight: 220,
        preferredMaxWidth: 880,
        keepAlive: true,
        escape: "close",
        dock: "bottom",
      },
    }),
    host.capabilities.register({
      id: "schedule",
      label: "Planner",
      plainDescription: "Plan prompts to run once or on a repeating cadence.",
      keywords: ["schedule", "planner", "planned", "recurring"],
      standardTier: "more",
      standardRank: 14,
      open: () => host.navigation.openWorkspacePane("schedule"),
      available: () => true,
    }),
    host.widgets.registerPlugin({
      id: "schedule",
      name: "Planner",
      widgets: [{
        id: "schedule.main",
        title: "Planner",
        description: "Plan prompts to run once or on a repeating cadence.",
        defaultSlot: "workspace.main",
        supportedSlots: ["workspace.main", "workspace.bottom"],
        defaultSize: { w: 12, h: 6 },
        render: () => createElement(PlannerView),
      }],
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
