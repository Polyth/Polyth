import { defineWebPackage } from "@polyth/web-sdk";
import PluginsPage from "./PluginsPage.tsx";
import { LIBRARY_OWNER } from "./packagesContext.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import "./styles.css";
export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "plugins", packageId: "plugins", label: tr("packages.plugins.pageTitle"), group: "Customize", icon: "plugin", nav: false, redirect: { pageId: "packages" }, component: () => null }),
    host.slots.register({ id: LIBRARY_OWNER, slot: "settings.packages.content", order: 20, render: (context) => <PluginsPage context={context} /> }),
    host.capabilities.register({ id: "diagnostics", label: tr("plugins.capability.label"), technicalLabel: tr("plugins.capability.technicalLabel"), plainDescription: tr("plugins.capability.description"), keywords: ["plugin", "package", "extension", "install", "logs"], standardTier: "technical", standardRank: 34, open: () => host.navigation.openSettingsPage("packages"), available: () => true }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
