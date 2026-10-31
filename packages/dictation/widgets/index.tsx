import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import VoicePage from "./VoicePage.tsx";
import {
  dictationControlsMounted,
  getVoicePrefs,
  installVoice,
  readLastReply,
  replaceVoicePrefs,
  stopSpeaking,
  subscribeVoicePrefs,
  toggleDictation,
} from "./voice.tsx";
import { voiceTour } from "./onboardingTour.ts";

export default defineWebPackage((host) => () => {
  const off = [
    host.preferences.register("package.dictation.voice", {
      read: getVoicePrefs,
      write: replaceVoicePrefs,
      subscribe: subscribeVoicePrefs,
    }),
    host.settings.registerPage({
      id: "voice",
      packageId: "dictation",
      label: "Voice",
      group: "Workspace",
      icon: "mic",
      order: 30,
      component: VoicePage,
    }),
    installVoice(host),
    host.onboarding
      ? host.onboarding.registerTour(voiceTour(host.ui.locale.translate))
      : () => {},
    host.capabilities.register({
      id: "voice",
      label: host.ui.locale.translate("dictation.voiceInputLabel"),
      technicalLabel: "Dictation",
      plainDescription: host.ui.locale.translate("dictation.voiceInputDescription"),
      keywords: ["voice", "dictation", "microphone", "speech"],
      standardTier: "more",
      standardRank: 19,
      open: () => host.navigation.openSettingsPage("voice"),
      available: () => true,
    }),
    host.slots.register({
      slot: "commandPalette.commands",
      id: "dictation.palette-commands",
      render: () => null,
      meta: {
        commands: [
          {
            // Also the target of the "Dictate" keyboard shortcut.
            id: "voice.dictate",
            label: host.ui.locale.translate("dictation.startStop"),
            group: "Voice",
            icon: "mic",
            keywords: ["dictate", "dictation", "microphone", "speech to text", "talk"],
            when: () => getVoicePrefs().dictation && dictationControlsMounted(),
            run: () => { toggleDictation(); },
          },
          {
            id: "voice.read",
            label: host.ui.locale.translate("dictation.readLastReply"),
            group: "Voice",
            icon: "volume",
            when: () => host.store.getSnapshot().activeSessionId !== null,
            run: readLastReply,
          },
          {
            id: "voice.stop",
            label: host.ui.locale.translate("dictation.stopReading"),
            group: "Voice",
            icon: "stop",
            run: stopSpeaking,
          },
        ],
      },
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
