import ModelsPage from "./ModelsPage.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { MODELS_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

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
