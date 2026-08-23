import { ManagedPluginsSection } from "../components/settings/pages.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { PLUGINS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installPluginsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "plugins",
      packageId: "plugins",
      label: "Plugins",
      group: "Customize",
      icon: "🧩",
      order: 20,
      component: ManagedPluginsSection,
      settingsItems: [
        {
          id: "plugins.managed",
          pageId: "plugins",
          label: "Managed plugins",
          description: "Install, enable, and inspect third-party plugins",
          keywords: ["install", "extension", "trust"],
          focusTarget: "plugins.managed",
        },
      ],
    }),
    registerPackageOnboarding(PLUGINS_TOUR),
  );
}
