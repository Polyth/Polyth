import SecureSafePage from "../components/settings/SecureSafePage.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { SECURE_SAFE_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";

export function installSecureSafePackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "secure-safe",
      packageId: "secure-safe",
      label: tr("packages.secureSafe.secureSafe"),
      group: "Engineering",
      icon: "🔐",
      order: 50,
      component: SecureSafePage,
      settingsItems: [
        {
          id: "secure-safe.entries",
          pageId: "secure-safe",
          label: tr("packages.secureSafe.secureSafeCredentials"),
          description: tr("packages.secureSafe.writeOnlyCredentialValuesStoredBehindReusable"),
          keywords: ["secret", "token", "password", "handle", "credential"],
          focusTarget: "secure-safe.entries",
        },
      ],
    }),
    registerPackageOnboarding(SECURE_SAFE_TOUR),
  );
}
