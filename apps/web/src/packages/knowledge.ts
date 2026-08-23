import { createElement } from "react";
import TracksPanel from "../components/TracksPanel.tsx";
import { registerCapability } from "../capabilities.ts";
import { registerSlot } from "../slots.ts";
import { setRailPlugin } from "../store.ts";
import { combineUnregister } from "./settingsPage.ts";

export function installKnowledgePackage(): () => void {
  const unregisterPanel = registerSlot(
    "workspace.right.tabs",
    "tracks",
    () => createElement(TracksPanel),
    1,
    { title: "Tracks" },
  );
  const unregisterCapability = registerCapability({
    id: "tracks",
    label: "Tracks",
    technicalLabel: "Spec-driven tracks",
    plainDescription: "Execute a saved feature spec one tested commit at a time.",
    keywords: ["track", "spec", "plan", "workflow", "atomic commit"],
    standardTier: "more",
    standardRank: 17,
    open: () => setRailPlugin("slot:tracks"),
    available: () => true,
  });
  return combineUnregister(unregisterPanel, unregisterCapability);
}
