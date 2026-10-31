// The GitHub tour is package-owned: disabling the github package removes it
// with the rest of the package's contributions. Strings live in this package's
// i18n catalog; the shell registry only stores the resulting tour.
import type { PackageOnboardingTour } from "@polyth/web-sdk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function githubTour(translate: Translate): PackageOnboardingTour {
  return {
    packageId: "github",
    title: translate("packages.onboarding.tours.installed.github"),
    steps: [
      {
        id: "overview",
        title: translate("packages.onboarding.tours.installed.keepRepositoryWorkInView"),
        body: translate("packages.onboarding.tours.installed.githubSurfacesProjectPullRequestsIssuesChecks"),
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "summary",
        title: translate("packages.onboarding.tours.installed.addTheActivePullRequestToYour"),
        body: translate("packages.onboarding.tours.installed.theSummaryWidgetLinksToTheCurrent"),
        highlight: translate("packages.onboarding.tours.installed.currentPullRequest"),
        highlightWhere: "workspace",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "metrics",
        title: translate("packages.onboarding.tours.installed.showOnlyUsefulDiffMetrics"),
        body: translate("packages.onboarding.tours.installed.chooseWhetherTheWidgetIncludesChangedFiles"),
        highlight: translate("packages.onboarding.tours.installed.changedFiles"),
        highlightWhere: "workspace",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  };
}
