import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { PLAYGROUND_PURPOSE } from "../src/index.ts";
import PlaygroundView from "./PlaygroundView.tsx";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({
      id: "playground",
      title: "Playground",
      shortLabel: "Playground",
      description: tr("playground.surface.description"),
      capabilityId: "playground",
      order: 6,
      component: (props) => createElement(PlaygroundView, { ...props, host }),
      presentation: withSurfaceContent({
        kind: "workspace",
        defaultRatio: 0.56,
        minWidth: 360,
        minHeight: 280,
        preferredMaxWidth: 1200,
        keepAlive: true,
        escape: "close",
      }, "workspace"),
    }),
    host.workbench.profiles.register({
      id: "playground",
      label: "Playground",
      description: tr("playground.profile.description"),
      order: 15,
      projectAffinity: { directions: ["engineering", "research"], recommended: true },
      defaultLayout: {
        surfaces: [
          { surface: "session", region: "primary", active: true },
          { surface: "playground", region: "end", active: true },
        ],
      },
      presentation: {
        text: "code",
        navigation: "primary",
        focused: true,
        sidebar: "projects",
        splitSurfaces: ["session", "playground"],
      },
      sessionPurpose: PLAYGROUND_PURPOSE,
    }),
    host.capabilities.register({
      id: "playground",
      label: "Playground",
      plainDescription: tr("playground.capability.description"),
      keywords: ["playground", "prototype", "design", "ui", "live preview", "artifact"],
      // The profile is a first-class workspace mode; keep the legacy
      // capability searchable in More instead of adding a second rail entry.
      standardTier: "more",
      standardRank: 5,
      defaultRails: { research: "right" },
      open: () => {
        if (!host.workbench.activateProfile("playground")) host.navigation.openWorkspacePane("playground");
      },
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
