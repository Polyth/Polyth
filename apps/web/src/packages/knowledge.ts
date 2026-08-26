import { createElement } from "react";
import TracksPanel from "../components/TracksPanel.tsx";
import { registerCapability } from "../capabilities.ts";
import { registerSlot } from "../slots.ts";
import { setRailPlugin } from "../store.ts";
import { registerPackageOnboarding } from "./onboarding/registry.ts";
import { KNOWLEDGE_TOUR } from "./onboarding/tours/installed.ts";
import { combineUnregister } from "./settingsPage.ts";
import { tr } from "../i18n/index.ts";
import { RAIL_ICONS } from "../railIcons.ts";

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
