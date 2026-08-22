import SecureSafePage from "../components/settings/SecureSafePage.tsx";
import { installSettingsPage } from "./settingsPage.ts";

export function installSecureSafePackage(): () => void {
  return installSettingsPage({
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
  });
}
