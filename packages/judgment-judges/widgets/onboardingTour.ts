// The Judges tour behind Settings → Judges' header "?". Package-owned:
// disabling the package removes it with the page. Strings live in this
// package's i18n catalog.
import type { PackageOnboardingTour } from "@polyth/web-sdk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function judgesTour(translate: Translate): PackageOnboardingTour {
  return {
    packageId: "judgment-judges",
    title: translate("judgesui.tourTitle"),
    steps: [
      { id: "what", title: translate("judgesui.tourWhatTitle"), body: translate("judgesui.tourWhatBody"), media: { kind: "pattern", pattern: "orbit" } },
      { id: "starters", title: translate("judgesui.tourStartersTitle"), body: translate("judgesui.tourStartersBody"),
        highlight: translate("judgesui.itemJudges"), media: { kind: "pattern", pattern: "tiles" } },
      { id: "access", title: translate("judgesui.tourAccessTitle"), body: translate("judgesui.tourAccessBody"), media: { kind: "pattern", pattern: "rays" } },
      { id: "try", title: translate("judgesui.tourTryTitle"), body: translate("judgesui.tourTryBody"), media: { kind: "pattern", pattern: "branches" } },
    ],
  };
}
