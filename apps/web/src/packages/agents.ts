import { AgentsPage } from "../components/settings/pages.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installAgentsPackage(): () => void {
  return installSettingsPage({
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
  });
}
