import { installGithubPlugin } from "../widgets/githubPlugin.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { GITHUB_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister } from "./settingsPage.ts";

export function installGithubPackage(): () => void {
  return combineUnregister(
    installGithubPlugin(),
    registerPackageOnboarding(GITHUB_TOUR),
  );
}
