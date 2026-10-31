// The Usage tour is package-owned: disabling the usage package removes it with
// the rest of the package's contributions. Strings live in this package's i18n
// catalog; the shell registry only stores the resulting tour.
import type { PackageOnboardingTour } from "@polyth/web-sdk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function usageTour(translate: Translate): PackageOnboardingTour {
  return {
    packageId: "usage",
    title: translate("packages.onboarding.tours.installed.usage"),
    steps: [
      {
        id: "overview",
        title: translate("packages.onboarding.tours.installed.understandModelActivityAndCost"),
        body: translate("packages.onboarding.tours.installed.usageCombinesSessionTokenAndCostTotals"),
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "range",
        title: translate("packages.onboarding.tours.installed.compareThePeriodThatMatters"),
        body: translate("packages.onboarding.tours.installed.reviewSpendTokensAndRequestTrendsOver"),
        highlight: translate("packages.onboarding.tours.installed.usageOverview"),
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "providers",
        title: translate("packages.onboarding.tours.installed.watchProviderHealth"),
        body: translate("packages.onboarding.tours.installed.inspectQuotaWindowsPaceAccountFreshnessAnd"),
        highlight: translate("packages.onboarding.tours.installed.providers"),
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  };
}
