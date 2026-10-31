import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import GoogleSettingsPage from "./GoogleSettingsPage.tsx";

export default defineWebPackage((host) => () => {
  const translate = (key: string) => host.ui.locale.translate(key);
  const off = [
    host.settings.registerPage({
      id: "google",
      packageId: "google",
      label: "Google",
      group: "Workspace",
      icon: "google",
      order: 45,
      component: ({ settingsTarget }) => createElement(GoogleSettingsPage, { host, ...(settingsTarget ? { settingsTarget } : {}) }),
      settingsItems: [
        { id: "google.accounts", pageId: "google", label: translate("google.settings.accountsLabel"), description: translate("google.settings.accountsDescription"), keywords: ["google", "gmail", "calendar", "drive", "account", "oauth", "personal"], focusTarget: "google.accounts" },
        { id: "google.service", pageId: "google", label: translate("google.settings.serviceLabel"), description: translate("google.settings.serviceDescription"), keywords: ["google", "service account", "shared", "space", "policy", "agents"], focusTarget: "google.service" },
        { id: "google.client", pageId: "google", label: translate("google.settings.clientLabel"), description: translate("google.settings.clientDescription"), keywords: ["google", "oauth", "client id", "client secret", "advanced", "google cloud", "setup", "json"], focusTarget: "google.client" },
      ],
    }),
    host.capabilities.register({
      id: "google",
      label: "Google",
      plainDescription: translate("google.capability.description"),
      keywords: ["google", "gmail", "email", "calendar", "drive", "docs", "sheets"],
      standardTier: "more",
      standardRank: 19,
      open: () => host.navigation.openSettingsPage("google"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
