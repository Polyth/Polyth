import type { PackageOnboardingTour } from "../types.ts";

export const VOICE_TOUR: PackageOnboardingTour = {
  packageId: "voice",
  title: "Voice",
  steps: [
    {
      id: "overview",
      title: "Talk to your workspace",
      body: "Dictate prompts instead of typing them. The Voice package adds push-to-talk dictation straight into the composer.",
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "dictation",
      title: "Tune dictation",
      body: "Pick your microphone and language on this page. Everything is saved as you change it.",
      highlight: "Dictation",
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};
