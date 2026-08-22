import CommandsPage from "../components/settings/CommandsPage.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installCommandsPackage(): () => void {
  return installSettingsPage({
    id: "commands",
    packageId: "commands",
    label: "Commands",
    group: "Engineering",
    icon: "/",
    order: 30,
    component: CommandsPage,
  });
}
