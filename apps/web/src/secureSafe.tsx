import SecureSafePage from "./components/settings/SecureSafePage.tsx";
import { registerSlot } from "./slots.ts";

registerSlot(
  "settings.pages",
  "secure-safe",
  () => <SecureSafePage />,
  20,
  {
    label: "Secure Safe",
    group: "Engineering",
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
  },
);
