import IntegrationsPage from "../components/settings/IntegrationsPage.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installIntegrationsPackage(): () => void {
  return installSettingsPage({
    id: "integrations",
    packageId: "integrations",
    label: "Integrations",
    group: "Workspace",
    icon: "🔗",
    order: 40,
    component: IntegrationsPage,
  });
}
