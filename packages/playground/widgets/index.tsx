import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import PlaygroundView from "./PlaygroundView.tsx";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: "playground",
      title: "Playground",
      shortLabel: "Playground",
      description: "Build and iterate on a live interactive prototype beside chat.",
      capabilityId: "playground",
      order: 6,
      component: (props) => createElement(PlaygroundView, { ...props, host }),
      presentation: {
        kind: "workspace",
        defaultRatio: 0.56,
        minWidth: 360,
        minHeight: 280,
        preferredMaxWidth: 1200,
        keepAlive: true,
        escape: "close",
      },
    }),
    host.workbench.profiles.register({
      id: "playground",
      label: "Playground",
      description: "Chat with an agent while the live prototype updates beside it.",
      order: 15,
      projectAffinity: { directions: ["engineering", "research"], recommended: true },
      defaultLayout: {
        surfaces: [
          { surface: "session", region: "primary", active: true },
          { surface: "playground", region: "end", active: true },
        ],
      },
      presentation: { text: "code" },
    }),
    host.capabilities.register({
      id: "playground",
      label: "Playground",
      plainDescription: "Build an interface with an agent and see every saved change live beside chat.",
      keywords: ["playground", "prototype", "design", "ui", "live preview", "artifact"],
      standardTier: "primary",
      standardRank: 5,
      open: () => {
        if (!host.workbench.activateProfile("playground")) host.navigation.openWorkspacePane("playground");
      },
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
