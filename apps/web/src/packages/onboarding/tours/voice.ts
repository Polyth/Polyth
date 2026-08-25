import type { PackageOnboardingTour } from "../types.ts";
import { tr } from "../../../i18n/index.ts";

export const VOICE_TOUR: PackageOnboardingTour = {
  packageId: "voice",
  title: tr("packages.onboarding.tours.voice.voice"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.voice.talkToYourWorkspace"),
      body: tr("packages.onboarding.tours.voice.voiceAddsDictationAndReadAloudSpeak"),
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "dictation",
      title: tr("packages.onboarding.tours.voice.dictateInsteadOfTyping"),
      body: tr("packages.onboarding.tours.voice.turnOnDictationToShowTheMic"),
      highlight: tr("packages.onboarding.tours.voice.dictation"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "read-aloud",
      title: tr("packages.onboarding.tours.voice.hearRepliesReadBack"),
      body: tr("packages.onboarding.tours.voice.readRepliesAloudSpeaksEachCompletedAssistant"),
      highlight: tr("packages.onboarding.tours.voice.readRepliesAloud"),
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};
