import ModelsPage from "../components/settings/ModelsPage.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installModelsPackage(): () => void {
  return installSettingsPage({
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
  });
}
