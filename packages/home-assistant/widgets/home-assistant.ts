import { HomeAssistantSettings, installHomeAssistantPlugin } from "./homeAssistantPlugin.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { HOME_ASSISTANT_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export function installHomeAssistantPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "home-assistant",
      packageId: "home-assistant",
      label: tr("packages.homeAssistant.homeAssistant"),
      group: "Workspace",
      icon: "🏠",
      order: 60,
      component: HomeAssistantSettings,
    }),
    installHomeAssistantPlugin(),
    registerPackageOnboarding(HOME_ASSISTANT_TOUR),
  );
}
