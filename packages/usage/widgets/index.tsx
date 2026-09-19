import "./styles.css";
import "./sessionUsage.css";
import "./dashboardSurface.css";
import { defineWebPackage } from "@polyth/web-sdk";
import { registerClientSettingsContribution } from "@polyth/web/client-settings";
import { UsageDashboard } from "./usage/UsageDashboard.tsx";
import {
  getUsagePrefs,
  parseUsagePrefs,
  replaceUsagePrefs,
  subscribeUsagePrefs,
} from "./usagePrefs.ts";
import { USAGE_WIDGET_PLUGIN } from "./sessionUsagePlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    registerClientSettingsContribution({
      id: "usage",
      get: getUsagePrefs,
      apply: (value) => replaceUsagePrefs(parseUsagePrefs(JSON.stringify(value ?? {}))),
      subscribe: subscribeUsagePrefs,
    }),
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
