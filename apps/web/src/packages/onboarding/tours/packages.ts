import type { PackageOnboardingTour } from "../types.ts";

export const PACKAGES_TOUR: PackageOnboardingTour = {
  packageId: "packages",
  title: "Packages",
  steps: [
    {
      id: "overview",
      title: "One workspace, modular features",
      body: "Polyth ships as a set of packages — Git, Voice, Usage and more. Each one brings its own settings page, widgets, and commands.",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "toggle",
      title: "Enable only what you need",
      body: "Each tile under Optional packages has a switch. Disabling one removes its settings page and widgets instantly — nothing to reinstall. Core packages stay on.",
      highlight: "Optional packages",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "replay",
      title: "Revisit any tour",
      body: "Every package with an introduction keeps a Tour button on its tile here, so you can replay it whenever you like — even after skipping.",
      highlight: "Tour",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};
