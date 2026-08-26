import VoicePage from "./VoicePage.tsx";
import { installVoice } from "./voice.tsx";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { VOICE_TOUR } from "../../../apps/web/src/packages/onboarding/tours/voice.ts";
import { combineUnregister, installSettingsPage } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

export function installVoicePackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "voice",
      packageId: "voice",
      label: tr("packages.voice.voice"),
      group: "Workspace",
      icon: "🎤",
      order: 30,
      component: VoicePage,
      settingsItems: [
        {
          id: "voice.dictation",
          pageId: "voice",
          label: tr("packages.voice.dictation"),
          keywords: ["microphone", "speech"],
          focusTarget: "voice.dictation",
        },
      ],
    }),
    installVoice(),
    registerPackageOnboarding(VOICE_TOUR),
  );
}
