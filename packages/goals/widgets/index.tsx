import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import GoalsView from "./GoalsView.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.workspaceSurfaces.register({ id: "goals", title: "Goals", order: 20, plugin: "goals", requires: "project", component: () => createElement(GoalsView) }),
    host.capabilities.register({ id: "goals", label: "Goals & progress", plainDescription: "Track goals and work progress.", keywords: ["goals", "progress", "status"], standardTier: "primary", standardRank: 3, open: () => host.navigation.setActiveView("goals"), available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
