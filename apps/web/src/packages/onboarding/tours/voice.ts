import type { PackageOnboardingTour } from "../types.ts";

export const VOICE_TOUR: PackageOnboardingTour = {
  packageId: "voice",
  title: "Voice",
  steps: [
    {
      id: "overview",
      title: "Talk to your workspace",
      body: "Voice adds dictation and read-aloud: speak prompts through the composer’s Dictate button, and have completed replies spoken back.",
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "dictation",
      title: "Dictate instead of typing",
      body: "Turn on Dictation to show the mic button in the composer — your speech is inserted as text. The Dictation engine switch picks the browser recognizer or a configured speech-to-text server.",
      highlight: "Dictation",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "read-aloud",
      title: "Hear replies read back",
      body: "Read replies aloud speaks each completed assistant reply. Enable Summarize before speaking to condense long replies first, and check the result with Speak sample.",
      highlight: "Read replies aloud",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};
