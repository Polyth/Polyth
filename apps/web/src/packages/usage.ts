import { UsageDashboard } from "../usage/UsageDashboard.tsx";
import { installUsagePlugin } from "../widgets/usagePlugin.tsx";
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
  );
}
