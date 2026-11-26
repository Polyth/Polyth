import { defineWebPackage } from "@polyth/web-sdk";
import type { SessionEvent } from "@polyth/contracts";
import PluginsPage from "./PluginsPage.tsx";
import InstallProposalBlock from "./InstallProposalBlock.tsx";
import { PACKAGE_INSTALL_PROPOSED_EVENT } from "../src/installProposal.ts";
import { LIBRARY_OWNER } from "./packagesContext.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import "./styles.css";
export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "plugins", packageId: "plugins", label: tr("packages.plugins.pageTitle"), group: "Customize", icon: "plugin", nav: false, redirect: { pageId: "packages" }, component: () => null }),
    host.slots.register({ id: LIBRARY_OWNER, slot: "settings.packages.content", order: 20, render: (context) => <PluginsPage context={context} /> }),
    // The install block an agent leaves for a package it built.
    host.slots.register({ id: "plugins.install-proposal", slot: "session.timeline.event", order: 30, meta: { eventTypes: [PACKAGE_INSTALL_PROPOSED_EVENT] },
      render: (props) => <InstallProposalBlock host={host} event={props.event as SessionEvent}
        sessionId={typeof props.sessionId === "string" ? props.sessionId : undefined} /> }),
    host.capabilities.register({ id: "diagnostics", label: tr("plugins.capability.label"), technicalLabel: tr("plugins.capability.technicalLabel"), plainDescription: tr("plugins.capability.description"), keywords: ["plugin", "package", "extension", "install", "logs"], standardTier: "technical", standardRank: 34, open: () => host.navigation.openSettingsPage("packages"), available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
