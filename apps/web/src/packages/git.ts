import { GitPage } from "../components/settings/pages.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installGitPackage(): () => void {
  return installSettingsPage({
    id: "git",
    packageId: "git",
    label: "Git",
    group: "Engineering",
    icon: "⎇",
    order: 10,
    component: GitPage,
  });
}
