import { UsageDashboard } from "../usage/UsageDashboard.tsx";
import { installUsagePlugin } from "../widgets/usagePlugin.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { USAGE_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installUsagePackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "usage",
      packageId: "usage",
      label: "Usage",
      group: "Workspace",
      icon: "📊",
      order: 50,
      component: UsageDashboard,
    }),
    installUsagePlugin(),
    registerPackageOnboarding(USAGE_TOUR),
  );
}
