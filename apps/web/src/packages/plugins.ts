import { ManagedPluginsSection } from "../components/settings/pages.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installPluginsPackage(): () => void {
  return installSettingsPage({
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
  });
}
