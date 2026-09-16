import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import type { SessionEvent } from "@polyth/contracts";
import PreviewView from "./PreviewView.tsx";
import BrowserActivity from "./BrowserActivity.tsx";
import BrowserSettingsPage from "./BrowserSettingsPage.tsx";
import { getBrowserVisibility } from "./browserVisibility.ts";
import { browserRequestKey, shouldAutoRevealBrowserRequest } from "./browserReveal.ts";

export default defineWebPackage((host) => () => {
  const seenRequests = new Set<string>();
  const translate = (key: string) => host.ui.locale.translate(key);
  const revealForBrowserRequest = (event: SessionEvent) => {
    const current = host.store.getSnapshot();
    if (!shouldAutoRevealBrowserRequest(event, current.activeSessionId, getBrowserVisibility())) return;
    const key = browserRequestKey(event);
    if (seenRequests.has(key)) return;
    seenRequests.add(key);
    if (seenRequests.size > 256) seenRequests.delete(seenRequests.values().next().value as string);
    // The navigation command is the live presentation path. The host routes
    // it through workbench.openSurface, preserving pinned/fullscreen/mobile
    // and the mounted Chat companion without opening the layout twice.
    host.navigation.openWorkspacePane("browser");
  };
  const off = [
    host.sessions.subscribeEvents(revealForBrowserRequest),
    host.settings.registerPage({
      id: "browser",
      packageId: "browser",
      label: translate("previewview.browser"),
      group: "Engineering",
      icon: "globe",
      order: 35,
      component: () => createElement(BrowserSettingsPage, { host }),
      settingsItems: [
        { id: "browser.agent-auto-approve", pageId: "browser", label: translate("browser.settings.agentAutoApprove"), keywords: ["browser", "auto-approve", "permission", "agent", "tool"], focusTarget: "browser.agent-auto-approve" },
        { id: "browser.visibility", pageId: "browser", label: translate("previewview.browserVisibility"), keywords: ["browser", "background", "auto-show", "visibility"], focusTarget: "browser.visibility" },
      ],
    }),
    host.slots.register({
      slot: "session.header.actions",
      id: "browser.activity",
      order: 12,
      render: () => createElement(BrowserActivity, { host }),
    }),
    host.surfaces.register({ id: "browser", title: translate("previewview.browser"), description: translate("previewview.openTheControlledBrowserSharedWithThe"), shortLabel: translate("previewview.browser"), capabilityId: "browser", order: 4, component: PreviewView, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.45, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "browser", label: translate("previewview.browser"), plainDescription: translate("previewview.enterAnHttpSAddressAbove"), keywords: ["browser", "element picker", "agent browser", "app"], standardTier: "primary", standardRank: 2, open: () => { host.navigation.openWorkspacePane("browser"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "browser", name: translate("previewview.browser"), widgets: [{ id: "browser.app", title: translate("previewview.browser"), description: translate("previewview.openTheControlledBrowserSharedWithThe"), defaultSlot: "workspace.bottom", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 6 }, render: () => createElement(PreviewView) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
