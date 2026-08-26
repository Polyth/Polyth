import { installGithubPlugin } from "./githubPlugin.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { GITHUB_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister } from "../../../apps/web/src/packages/settingsPage.ts";

export function installGithubPackage(): () => void {
  return combineUnregister(
    installGithubPlugin(),
    registerPackageOnboarding(GITHUB_TOUR),
  );
}
