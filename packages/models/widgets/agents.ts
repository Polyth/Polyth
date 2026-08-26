import { AgentsPage } from "../../../apps/web/src/components/settings/pages.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { AGENTS_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export function installAgentsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "agents",
      packageId: "models",
      label: tr("packages.agents.roles"),
      group: "Engineering",
      icon: "◎",
      order: 25,
      component: AgentsPage,
      settingsItems: [
        {
          id: "agents.profiles",
          pageId: "agents",
          label: tr("packages.agents.agentProfiles"),
          keywords: ["preset", "pin", "model"],
          focusTarget: "agents.profiles",
        },
      ],
    }),
    registerPackageOnboarding(AGENTS_TOUR),
  );
}
