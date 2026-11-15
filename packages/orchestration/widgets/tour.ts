// The Orchestration tour is package-owned, so disabling the package removes it.
// `highlight` strings are the exact visible labels of the controls they explain.
import type { PackageOnboardingTour } from "@polyth/web-sdk";
import type { Translate } from "./helpers.ts";

export function orchestrationTour(translate: Translate): PackageOnboardingTour {
  const step = (id: string, highlight: string | undefined, body: string, title?: string) => ({
    id,
    title: title ?? highlight ?? "",
    body,
    ...(highlight ? { highlight, highlightWhere: "settings" as const } : { highlightWhere: "settings" as const }),
  });
  return {
    packageId: "orchestration",
    title: translate("orchestration.tour.title"),
    steps: [
      {
        ...step("intro", undefined, translate("orchestration.tour.intro.body"), translate("orchestration.tour.intro.title")),
        media: { kind: "pattern", pattern: "branches" },
      },
      step("mode", translate("orchestration.mode.title"), translate("orchestration.tour.mode.body")),
      step("now", translate("orchestration.tabs.now"), translate("orchestration.tour.now.body")),
      step("roles", translate("orchestration.tabs.roles"), translate("orchestration.tour.roles.body")),
      step("fill", translate("orchestration.roles.fill"), translate("orchestration.tour.fill.body")),
      step("quota", translate("orchestration.safe.quota"), translate("orchestration.tour.quota.body")),
      step("excluded", translate("orchestration.safe.excluded"), translate("orchestration.tour.excluded.body")),
      step("agent-text", translate("orchestration.now.agentText"), translate("orchestration.tour.agentText.body")),
    ],
  };
}
