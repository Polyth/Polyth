import { PluginsPage } from "../../../apps/web/src/components/settings/pages.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { PLUGINS_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
