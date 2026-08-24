import VoicePage from "../components/settings/VoicePage.tsx";
import { installVoice } from "../voice.tsx";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { VOICE_TOUR } from "./onboarding/tours/voice.ts";
import { combineUnregister, installSettingsPage } from "./settingsPage.ts";

export function installVoicePackage(): () => void {
  return combineUnregister(
    installSettingsPage({
      id: "voice",
      packageId: "voice",
      label: "Voice",
      group: "Workspace",
      icon: "🎤",
      order: 30,
      component: VoicePage,
      settingsItems: [
        {
          id: "voice.dictation",
          pageId: "voice",
          label: "Dictation",
          keywords: ["microphone", "speech"],
          focusTarget: "voice.dictation",
        },
      ],
    }),
    installVoice(),
    registerPackageOnboarding(VOICE_TOUR),
  );
}
