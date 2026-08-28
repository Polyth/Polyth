import "./styles.css";
import { defineWebPackage } from "@polyth/web-sdk";
import VoicePage from "./VoicePage.tsx";
import { installVoice, readLastReply, stopSpeaking } from "./voice.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({
      id: "voice",
      packageId: "dictation",
      label: "Voice",
      group: "Workspace",
      icon: "🎤",
      order: 30,
      component: VoicePage,
    }),
    installVoice(),
    host.capabilities.register({
      id: "voice",
      label: "Voice input",
      technicalLabel: "Dictation",
      plainDescription: "Talk instead of typing.",
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
            id: "voice.read",
            label: "Read last reply aloud",
            group: "Voice",
            icon: "volume",
            when: () => host.store.getSnapshot().activeSessionId !== null,
            run: readLastReply,
          },
          {
            id: "voice.stop",
            label: "Stop reading aloud",
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
