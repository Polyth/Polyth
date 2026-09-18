import "./styles.css";
import "./sessionUsage.css";
import "./dashboardSurface.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { UsageDashboard } from "./usage/UsageDashboard.tsx";
import UsageSettings from "./usage/UsageSettings.tsx";
import { USAGE_WIDGET_PLUGIN } from "./sessionUsagePlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "usage", packageId: "usage", label: "Usage", group: "Workspace", icon: "usage", order: 50, component: UsageSettings }),
    host.settings.registerItems([
      { id: "usage.appearance", pageId: "usage", label: "Usage appearance", description: "Dashboard density and reporting range.", keywords: ["usage", "appearance", "density", "range"], focusTarget: "usage.appearance" },
      { id: "usage.charts", pageId: "usage", label: "Usage charts", description: "Chart style, metric, and legends.", keywords: ["usage", "chart", "graph", "metric"], focusTarget: "usage.charts" },
      { id: "usage.statistics", pageId: "usage", label: "Usage statistics", description: "Choose visible dashboard statistics.", keywords: ["usage", "statistics", "cards", "visibility"], focusTarget: "usage.statistics" },
      { id: "usage.costs", pageId: "usage", label: "Provider billing", description: "API or subscription billing metadata and monthly cost.", keywords: ["usage", "provider", "billing", "subscription", "api", "cost"], focusTarget: "usage.costs" },
    ]),
    host.surfaces.register({
      id: "usage",
      title: "Usage",
      description: "Review token, cost, and provider quota usage.",
      capabilityId: "usage",
      order: 50,
      component: UsageDashboard,
      presentation: { kind: "workspace", defaultRatio: 0.58, minWidth: 320, preferredMaxWidth: 980, keepAlive: true, escape: "close" },
    }),
    host.widgets.registerPlugin(USAGE_WIDGET_PLUGIN),
    host.capabilities.register({ id: "usage", label: "Usage & cost", plainDescription: "See token, cost, and provider quota usage.", keywords: ["usage", "cost", "tokens", "quota"], standardTier: "more", standardRank: 15, open: () => host.navigation.openWorkspacePane("usage"), available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
