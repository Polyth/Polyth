// The SSH Remotes tour is package-owned: disabling the ssh package removes it
// with the rest of the package's contributions. Strings live in this package's
// i18n catalog; the shell registry only stores the resulting tour.
import type { PackageOnboardingTour } from "@polyth/web-sdk";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function sshTour(translate: Translate): PackageOnboardingTour {
  return {
    packageId: "ssh",
    title: translate("packages.onboarding.tours.installed.sshRemotes"),
    steps: [
      {
        id: "overview",
        title: translate("packages.onboarding.tours.installed.runCodingAgentsOnYourServers"),
        body: translate("packages.onboarding.tours.installed.sshRemotesKeepsAnInventoryOfServers"),
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "add",
        title: translate("packages.onboarding.tours.installed.registerAServerWithoutSecrets"),
        body: translate("packages.onboarding.tours.installed.addANameHostOrSshConfig"),
        highlight: translate("packages.onboarding.tours.installed.server"),
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "test",
        title: translate("packages.onboarding.tours.installed.proveTheConnectionEndToEnd"),
        body: translate("packages.onboarding.tours.installed.testMeasuresTheRoundTripAndProbes"),
        highlight: translate("packages.onboarding.tours.installed.test"),
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "remote-projects",
        title: translate("packages.onboarding.tours.installed.openProjectsOnTheServer"),
        body: translate("packages.onboarding.tours.installed.fromTheProjectPickerChooseOpenOn"),
        highlight: translate("packages.onboarding.tours.installed.openOnAServer"),
        highlightWhere: "workspace",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  };
}
