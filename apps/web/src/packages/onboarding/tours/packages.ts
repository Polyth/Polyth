import type { PackageOnboardingTour } from "../types.ts";
import { tr } from "../../../i18n/index.ts";

export const PACKAGES_TOUR: PackageOnboardingTour = {
  packageId: "packages",
  title: tr("packages.onboarding.tours.packages.packages"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.packages.oneWorkspaceModularFeatures"),
      body: tr("packages.onboarding.tours.packages.polythShipsAsASetOfPackages"),
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "toggle",
      title: tr("packages.onboarding.tours.packages.enableOnlyWhatYouNeed"),
      body: tr("packages.onboarding.tours.packages.eachTileUnderOptionalPackagesHasA"),
      highlight: tr("packages.onboarding.tours.packages.optionalPackages"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "replay",
      title: tr("packages.onboarding.tours.packages.revisitAnyTour"),
      body: tr("packages.onboarding.tours.packages.everyPackageWithAnIntroductionKeepsA"),
      highlight: tr("packages.onboarding.tours.packages.tour"),
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};
