import type { PackageOnboardingTour } from "../types.ts";
import { tr } from "../../../i18n/index.ts";

export const GIT_TOUR: PackageOnboardingTour = {
  packageId: "git",
  title: tr("packages.onboarding.tours.git.git"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.git.sourceControlInSession"),
      body: tr("packages.onboarding.tours.git.gitKeepsTheActiveProjectSRepository"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "source-control",
      title: tr("packages.onboarding.tours.git.workTheRepositoryFromAPane"),
      body: tr("packages.onboarding.tours.git.toggleTheSourceControlPaneWithMod"),
      highlight: tr("packages.onboarding.tours.git.sourceControl"),
      highlightWhere: "pane",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "pending-changes",
      title: tr("packages.onboarding.tours.git.pendingChangesAtAGlance"),
      body: tr("packages.onboarding.tours.git.theWorkspaceFilesChangedWidgetSitsJust"),
      highlight: tr("packages.onboarding.tours.git.workspaceFilesChanged"),
      highlightWhere: "composer",
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "personas",
      title: tr("packages.onboarding.tours.git.commitAsTheRightIdentity"),
      body: tr("packages.onboarding.tours.git.onTheGitSettingsPageSaveGit"),
      highlight: tr("packages.onboarding.tours.git.gitPersonas"),
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};
