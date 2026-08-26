import { createElement } from "react";
import TracksPanel from "./TracksPanel.tsx";
import { registerCapability } from "../../../apps/web/src/capabilities.ts";
import { registerSlot } from "../../../apps/web/src/slots.ts";
import { setRailPlugin } from "../../../apps/web/src/store.ts";
import { registerPackageOnboarding } from "../../../apps/web/src/packages/onboarding/registry.ts";
import { KNOWLEDGE_TOUR } from "../../../apps/web/src/packages/onboarding/tours/installed.ts";
import { combineUnregister } from "../../../apps/web/src/packages/settingsPage.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { RAIL_ICONS } from "../../../apps/web/src/railIcons.ts";

export function installKnowledgePackage(): () => void {
  const unregisterPanel = registerSlot(
    "workspace.right.tabs",
    "tracks",
    () => createElement(TracksPanel),
    1,
    {
      title: tr("packages.knowledge.tracks"),
      capabilityId: "tracks",
      icon: RAIL_ICONS.tracks,
    },
  );
  const unregisterCapability = registerCapability({
    id: "tracks",
    label: tr("packages.knowledge.tracks"),
    technicalLabel: "Spec-driven tracks",
    plainDescription: tr("packages.knowledge.executeASavedFeatureSpecOneTested"),
    keywords: ["track", "spec", "plan", "workflow", "atomic commit"],
    standardTier: "more",
    standardRank: 17,
    open: () => setRailPlugin("slot:tracks"),
    available: () => true,
  });
  return combineUnregister(
    unregisterPanel,
    unregisterCapability,
    registerPackageOnboarding(KNOWLEDGE_TOUR),
  );
}
