import SecureSafePage from "../components/settings/SecureSafePage.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { SECURE_SAFE_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installSecureSafePackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "secure-safe",
      packageId: "secure-safe",
      label: "Secure Safe",
      group: "Engineering",
      icon: "🔐",
      order: 50,
      component: SecureSafePage,
      settingsItems: [
        {
          id: "secure-safe.entries",
          pageId: "secure-safe",
          label: "Secure Safe credentials",
          description: "Write-only credential values stored behind reusable handles",
          keywords: ["secret", "token", "password", "handle", "credential"],
          focusTarget: "secure-safe.entries",
        },
      ],
    }),
    registerPackageOnboarding(SECURE_SAFE_TOUR),
  );
}
