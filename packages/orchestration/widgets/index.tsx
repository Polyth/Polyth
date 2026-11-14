import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ORCHESTRATION_PACKAGE_ID } from "../src/contracts.ts";
import OrchestrationSettingsPage from "./SettingsPage.tsx";
import { orchestrationTour } from "./tour.ts";

const KEYWORDS = ["subagent", "delegation", "delegate", "routing", "model priority", "fallback", "quota", "worker", "orchestration", "agent.models"];

export default defineWebPackage((host) => () => {
  const translate = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(key, values);
  const item = (id: string, label: string, description: string) => ({
    id,
    pageId: ORCHESTRATION_PACKAGE_ID,
    label,
    description,
    keywords: KEYWORDS,
    focusTarget: id,
  });
  const off = [
    // Feature-detected: an older host has no package tours.
    host.onboarding ? host.onboarding.registerTour(orchestrationTour(translate)) : () => {},
    host.settings.registerPage({
      // The page id equals the package id so the shell's header "?" opens this tour.
      id: ORCHESTRATION_PACKAGE_ID,
      packageId: ORCHESTRATION_PACKAGE_ID,
      label: tr("orchestration.page.label"),
      group: "Workspace",
      icon: "hierarchy",
      order: 46,
      component: ({ settingsTarget }) => createElement(OrchestrationSettingsPage, { host, settingsTarget }),
      settingsItems: [
        item("orchestration.mode", tr("orchestration.mode.title"), tr("orchestration.mode.autoHint")),
        item("orchestration.roles", tr("orchestration.tabs.roles"), tr("orchestration.mode.rolesHint")),
        item("orchestration.quota-ceiling", tr("orchestration.safe.quota"), tr("orchestration.safe.quotaHint")),
        item("orchestration.excluded", tr("orchestration.safe.excluded"), tr("orchestration.safe.excludedHint")),
        item("orchestration.max-children", tr("orchestration.safe.parallel"), tr("orchestration.safe.parallelHint")),
        item("orchestration.agent-text", tr("orchestration.now.agentText"), tr("orchestration.tour.agentText.body")),
      ],
    }),
  ];
  return () => {
    for (const dispose of off.toReversed()) dispose();
  };
});
