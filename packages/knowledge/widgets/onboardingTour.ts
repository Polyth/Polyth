// The Knowledge tour is package-owned: disabling the knowledge package removes
// it with the rest of the package's contributions. Strings live in this
// package's i18n catalog; the shell registry only stores the resulting tour.
import type { PackageOnboardingTour } from "@polyth/web-sdk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function knowledgeTour(translate: Translate): PackageOnboardingTour {
  return {
    packageId: "knowledge",
    title: translate("packages.onboarding.tours.installed.knowledge"),
    steps: [
      {
        id: "overview",
        title: translate("packages.onboarding.tours.installed.keepDurableProjectContext"),
        body: translate("packages.onboarding.tours.installed.knowledgeStoresNotesPlansAndReusableContext"),
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "tracks",
        title: translate("packages.onboarding.tours.installed.executeASavedFeatureSpec"),
        body: translate("packages.onboarding.tours.installed.tracksTurnsASpecificationIntoTestedAtomic"),
        highlight: translate("packages.onboarding.tours.installed.tracks"),
        highlightWhere: "workspace",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "notes",
        title: translate("packages.onboarding.tours.installed.keepReferenceMaterialVisible"),
        body: translate("packages.onboarding.tours.installed.addTheProjectKnowledgePanelToA"),
        highlight: translate("packages.onboarding.tours.installed.notesMemory"),
        highlightWhere: "workspace",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  };
}
