import ModelsPage from "../components/settings/ModelsPage.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { MODELS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installModelsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "models",
      packageId: "models",
      label: "Providers & Models",
      group: "Engineering",
      icon: "◈",
      order: 20,
      component: ModelsPage,
      settingsItems: [
        {
          id: "models.favorites",
          pageId: "models",
          label: "Model favorites",
          keywords: ["pin", "provider"],
          focusTarget: "models.favorites",
        },
      ],
    }),
    registerPackageOnboarding(MODELS_TOUR),
  );
}
