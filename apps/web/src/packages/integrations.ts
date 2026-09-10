import IntegrationsPage from "../components/settings/IntegrationsPage.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { INTEGRATIONS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

export function installIntegrationsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "integrations",
      packageId: "integrations",
      label: tr("packages.integrations.integrations"),
      group: "Workspace",
      icon: "link",
      order: 40,
      component: IntegrationsPage,
    }),
    registerPackageOnboarding(INTEGRATIONS_TOUR),
  );
}
