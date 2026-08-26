import { defineWebPackage } from "@polyth/web-sdk";
import { UsageDashboard } from "./usage/UsageDashboard.tsx";
import { USAGE_WIDGET_PLUGIN } from "./usagePlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "usage", packageId: "usage", label: "Usage", group: "Workspace", icon: "📊", order: 50, component: UsageDashboard }),
    host.surfaces.register({
      id: "usage",
      title: "Usage",
      capabilityId: "usage",
      order: 50,
      component: UsageDashboard,
    }),
    host.widgets.registerPlugin(USAGE_WIDGET_PLUGIN),
    host.capabilities.register({ id: "usage", label: "Usage & cost", plainDescription: "See token, cost, and provider quota usage.", keywords: ["usage", "cost", "tokens", "quota"], standardTier: "more", standardRank: 15, open: () => host.navigation.openRailSurface("usage"), available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
