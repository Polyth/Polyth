// Apps web entry: the "Save as app" button on a page an agent drew, and the
// window the saved apps open in. Everything reaches the shell through generic
// seams, so a disabled or removed package leaves pages and chats as they were.
import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import { AppsIcon } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import AppsPanel from "./AppsPanel.tsx";
import { connectApps } from "./client.ts";
import { savePageAsApp } from "./commands.ts";
import { PAGE_APPS_SURFACE_ID, SAVE_ACTION_ID } from "./ids.ts";

export default defineWebPackage((host) => () => {
  const disconnect = connectApps();
  const off = [
    host.surfaces.register({
      id: PAGE_APPS_SURFACE_ID,
      title: tr("pageapps.surface.title"),
      description: tr("pageapps.surface.description"),
      capabilityId: PAGE_APPS_SURFACE_ID,
      order: 44,
      component: (props) => createElement(AppsPanel, { host, ...props }),
      // A running app fills its window edge to edge, so the content owns its
      // own padding (the list) instead of the host's page rhythm.
      presentation: withSurfaceContent(
        { kind: "workspace", defaultRatio: 0.5, minWidth: 340, preferredMaxWidth: 1040, keepAlive: true, escape: "close" },
        "workspace",
      ),
    }),
    host.capabilities.register({
      id: PAGE_APPS_SURFACE_ID,
      label: tr("pageapps.surface.title"),
      plainDescription: tr("pageapps.capability.description"),
      keywords: ["app", "apps", "artifact", "page", "tool", "mini app", "install"],
      icon: AppsIcon,
      standardTier: "more",
      standardRank: 20,
      defaultRails: {
        general: "right",
        engineering: "right",
        research: "right",
        operations: "right",
        home: "right",
        wellbeing: "right",
        finance: "right",
        personal: "right",
      },
      open: () => { host.navigation.openWorkspacePane(PAGE_APPS_SURFACE_ID); },
      available: () => true,
    }),
  ];
  // The button on a ```page block, on hosts that have the seam.
  const offAction = host.markdown?.registerFenceAction?.({
    id: SAVE_ACTION_ID,
    languages: ["page"],
    label: () => tr("pageapps.action.save"),
    icon: AppsIcon,
    order: 10,
    run: (input) => savePageAsApp(host, input),
  });
  if (offAction) off.push(offAction);
  return () => {
    for (const dispose of off.toReversed()) dispose();
    disconnect();
  };
});
