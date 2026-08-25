import { UsageDashboard } from "../usage/UsageDashboard.tsx";
import { installUsagePlugin } from "../widgets/usagePlugin.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { USAGE_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

export function installUsagePackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "usage",
      packageId: "usage",
      label: tr("packages.usage.usage"),
      group: "Workspace",
      icon: "📊",
      order: 50,
      component: UsageDashboard,
      settingsItems: [
        {
          id: "usage.dashboard",
          pageId: "usage",
          label: "Usage dashboard",
          description: "Workspace token, cost, model, and provider analytics",
          keywords: ["spend", "tokens", "models", "providers", "quota"],
          focusTarget: "usage.dashboard",
        },
      ],
    }),
    installUsagePlugin(),
    registerPackageOnboarding(USAGE_TOUR),
  );
}
