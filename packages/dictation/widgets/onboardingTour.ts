// The Voice tour is package-owned: disabling the dictation package removes it
// with the rest of the package's contributions. Strings live in this package's
// i18n catalog; the shell registry only stores the resulting tour.
import type { PackageOnboardingTour } from "@polyth/web-sdk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function voiceTour(translate: Translate): PackageOnboardingTour {
  return {
    packageId: "voice",
    title: translate("packages.onboarding.tours.voice.voice"),
    steps: [
      {
        id: "overview",
        title: translate("packages.onboarding.tours.voice.talkToYourWorkspace"),
        body: translate("packages.onboarding.tours.voice.voiceAddsDictationAndReadAloudSpeak"),
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "dictation",
        title: translate("packages.onboarding.tours.voice.dictateInsteadOfTyping"),
        body: translate("packages.onboarding.tours.voice.turnOnDictationToShowTheMic"),
        highlight: translate("packages.onboarding.tours.voice.dictation"),
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "read-aloud",
        title: translate("packages.onboarding.tours.voice.hearRepliesReadBack"),
        body: translate("packages.onboarding.tours.voice.readRepliesAloudSpeaksEachCompletedAssistant"),
        highlight: translate("packages.onboarding.tours.voice.readRepliesAloud"),
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  };
}
