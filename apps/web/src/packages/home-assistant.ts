import { HomeAssistantSettings, installHomeAssistantPlugin } from "../widgets/homeAssistantPlugin.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { HOME_ASSISTANT_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

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
