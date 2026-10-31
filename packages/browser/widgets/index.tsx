import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import type { SessionEvent } from "@polyth/contracts";
import type { MessageActionSlotMeta } from "@polyth/web-sdk";
import { ExternalLinkIcon } from "../../../apps/web/src/components/ui/index.ts";
import PreviewView from "./PreviewView.tsx";
import CredentialFillApprovalCard from "./CredentialFillApprovalCard.tsx";
import BrowserSettingsPage from "./BrowserSettingsPage.tsx";
import MessageLinksAction, { messageHasLinks, messageTextOf } from "./MessageLinksAction.tsx";
import { publishBrowserSessionEvent } from "./browserSignals.ts";
import { getBrowserVisibility, setBrowserVisibility, subscribeBrowserVisibility } from "./browserVisibility.ts";
import {
  browserRequestKey,
  shouldAutoRevealBrowserRequest,
} from "./browserReveal.ts";

export default defineWebPackage((host) => () => {
  const seenRequests = new Set<string>();
  const translate = (key: string) => host.ui.locale.translate(key);
  const revealForBrowserRequest = (event: SessionEvent) => {
    const current = host.store.getSnapshot();
    // Vault-fill approvals live in the active chat timeline. Do not steal
    // focus by opening Browser; the card reloads the same server-side pending
    // request on this event and is available even when Browser is not mounted.
    if (event.type === "browser/vault-fill-requested") return;
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
    host.preferences.register("package.browser.visibility", {
      read: getBrowserVisibility,
      write: (value) => setBrowserVisibility(value === "auto-show" ? "auto-show" : "background"),
      subscribe: subscribeBrowserVisibility,
    }),
    host.slots.register({
      slot: "session.timeline.after",
      id: "browser.credential-fill-approval",
      order: 15,
      render: (context) => createElement(CredentialFillApprovalCard, {
        projectId: typeof context.projectId === "string" ? context.projectId : null,
        sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
      }),
    }),
    host.slots.register({
      slot: "session.message.actions",
      id: "browser.message-links",
      order: 40,
      render: (context) => createElement(MessageLinksAction, {
        text: messageTextOf(context),
        projectId: typeof context.projectId === "string" ? context.projectId : null,
        sessionId: typeof context.sessionId === "string" ? context.sessionId : null,
        openPane: () => { host.navigation.openWorkspacePane("browser"); },
        messageActionPlacement: context.messageActionPlacement,
        messageActionRequest: context.messageActionRequest,
        messageActionAnchor: context.messageActionAnchor,
      }),
      meta: {
        messageAction: {
          label: () => translate("browser.links.openInBrowser"),
          description: () => translate("browser.links.description"),
          icon: ExternalLinkIcon,
          available: messageHasLinks,
          menu: true,
        } satisfies MessageActionSlotMeta,
      },
    }),
    host.sessions.subscribeEvents(revealForBrowserRequest),
    host.sessions.subscribeEvents(publishBrowserSessionEvent),
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
        { id: "browser.vault-fill-approvals", pageId: "browser", label: translate("browser.settings.vaultFillApprovals"), keywords: ["browser", "credential", "vault", "approval", "origin"], focusTarget: "browser.vault-fill-approvals" },
      ],
    }),
    host.surfaces.register({ id: "browser", title: translate("previewview.browser"), description: translate("previewview.openTheControlledBrowserSharedWithThe"), shortLabel: translate("previewview.browser"), capabilityId: "browser", order: 4, component: PreviewView, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.45, minWidth: 380, preferredMaxWidth: 760, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "browser", label: translate("previewview.browser"), plainDescription: translate("previewview.enterAnHttpSAddressAbove"), keywords: ["browser", "element picker", "agent browser", "app"], standardTier: "primary", standardRank: 2, defaultRails: { general: "top", engineering: "top", research: "top" }, open: () => { host.navigation.openWorkspacePane("browser"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "browser", name: translate("previewview.browser"), widgets: [{ id: "browser.app", title: translate("previewview.browser"), description: translate("previewview.openTheControlledBrowserSharedWithThe"), defaultSlot: "workspace.bottom", supportedSlots: ["workspace.main", "workspace.bottom"], defaultSize: { w: 12, h: 6 }, render: (context) => createElement(PreviewView, { projectId: context.projectId, sessionId: context.sessionId }) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
