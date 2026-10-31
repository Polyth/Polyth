import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import { CREATIVE_STUDIO_PACKAGE_ID, CREATIVE_STUDIO_PURPOSE } from "../src/index.ts";
import ReturnToStudio from "./ReturnToStudio.tsx";
import StudioView from "./StudioView.tsx";
import { studioStrings } from "./strings.ts";
import "./styles.css";

export default defineWebPackage((host) => () => {
  const t = studioStrings(host.ui.locale.get());
  const off = [
    host.surfaces.register({
      id: CREATIVE_STUDIO_PACKAGE_ID,
      title: t.title,
      shortLabel: t.shortLabel,
      description: t.surfaceDescription,
      capabilityId: CREATIVE_STUDIO_PACKAGE_ID,
      order: 7,
      component: (props) => createElement(StudioView, { ...props, host }),
      presentation: withSurfaceContent({
        kind: "workspace",
        defaultRatio: 0.6,
        minWidth: 380,
        minHeight: 320,
        preferredMaxWidth: 1400,
        keepAlive: true,
        escape: "close",
      }, "workspace"),
    }),
    // The studio is the whole workspace, not a panel beside a chat: each
    // video is a chat of its own lane that the studio covers, talks to and
    // reveals on request.
    host.workbench.profiles.register({
      id: CREATIVE_STUDIO_PACKAGE_ID,
      label: t.title,
      description: t.profileDescription,
      order: 16,
      defaultLayout: {
        surfaces: [
          { surface: "session", region: "primary", active: true },
          { surface: CREATIVE_STUDIO_PACKAGE_ID, region: "end", active: true },
        ],
      },
      presentation: {
        text: "prose",
        navigation: "primary",
        homeSurface: CREATIVE_STUDIO_PACKAGE_ID,
      },
      sessionPurpose: CREATIVE_STUDIO_PURPOSE,
    }),
    host.slots.register({
      slot: "session.composer.before",
      id: `${CREATIVE_STUDIO_PACKAGE_ID}.return`,
      order: -20,
      render: (props) => createElement(ReturnToStudio, { host, sessionId: typeof props.sessionId === "string" ? props.sessionId : null }),
    }),
    host.capabilities.register({
      id: CREATIVE_STUDIO_PACKAGE_ID,
      label: t.title,
      plainDescription: t.capabilityDescription,
      keywords: ["video", "music video", "clip", "animation", "storyboard", "three.js", "canvas", "svg", "ffmpeg", "кліп", "відео"],
      standardTier: "more",
      standardRank: 6,
      open: () => {
        if (!host.workbench.activateProfile(CREATIVE_STUDIO_PACKAGE_ID)) host.navigation.openWorkspacePane(CREATIVE_STUDIO_PACKAGE_ID);
      },
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
