import { PluginsPage } from "../components/settings/pages.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { PLUGINS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

export function installPluginsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "plugins",
      packageId: "plugins",
      label: tr("packages.plugins.plugins"),
      group: "Customize",
      icon: "🧩",
      order: 20,
      component: PluginsPage,
      settingsItems: [
        {
          id: "plugins.opencode",
          pageId: "plugins",
          label: "OpenCode plugins",
          description: "Import plugin configuration from JSON",
          keywords: ["opencode", "json", "otto", "runtime"],
          focusTarget: "plugins.opencode",
        },
        {
          id: "plugins.managed",
          pageId: "plugins",
          label: tr("packages.plugins.managedPlugins"),
          description: tr("packages.plugins.installEnableAndInspectThirdPartyPlugins"),
          keywords: ["install", "extension", "trust"],
          focusTarget: "plugins.managed",
        },
      ],
    }),
    registerPackageOnboarding(PLUGINS_TOUR),
  );
}
