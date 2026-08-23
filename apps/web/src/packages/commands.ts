import CommandsPage from "../components/settings/CommandsPage.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { COMMANDS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installCommandsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "commands",
      packageId: "commands",
      label: "Commands",
      group: "Engineering",
      icon: "/",
      order: 30,
      component: CommandsPage,
    }),
    registerPackageOnboarding(COMMANDS_TOUR),
  );
}
