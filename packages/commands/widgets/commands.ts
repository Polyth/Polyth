import CommandsPage from "./CommandsPage.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { COMMANDS_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export function installCommandsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "commands",
      packageId: "commands",
      label: tr("packages.commands.commands"),
      group: "Engineering",
      icon: "/",
      order: 30,
      component: CommandsPage,
    }),
    registerPackageOnboarding(COMMANDS_TOUR),
  );
}
