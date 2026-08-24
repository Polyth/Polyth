import { AgentsPage } from "../components/settings/pages.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { AGENTS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installAgentsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "agents",
      packageId: "models",
      label: "Roles",
      group: "Engineering",
      icon: "◎",
      order: 25,
      component: AgentsPage,
      settingsItems: [
        {
          id: "agents.profiles",
          pageId: "agents",
          label: "Agent profiles",
          keywords: ["preset", "pin", "model"],
          focusTarget: "agents.profiles",
        },
      ],
    }),
    registerPackageOnboarding(AGENTS_TOUR),
  );
}
