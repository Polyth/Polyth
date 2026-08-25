import ModelsPage from "../components/settings/ModelsPage.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { MODELS_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

export function installModelsPackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "models",
      packageId: "models",
      label: tr("packages.models.providersModels"),
      group: "Engineering",
      icon: "◈",
      order: 20,
      component: ModelsPage,
      settingsItems: [
        {
          id: "models.favorites",
          pageId: "models",
          label: tr("packages.models.modelFavorites"),
          keywords: ["pin", "provider"],
          focusTarget: "models.favorites",
        },
      ],
    }),
    registerPackageOnboarding(MODELS_TOUR),
  );
}
