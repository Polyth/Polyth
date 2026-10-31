import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import { webSearchCopy } from "./copy.ts";
import WebSearchSettingsPage from "./WebSearchSettingsPage.tsx";

export default defineWebPackage((host) => () => {
  const copy = webSearchCopy(host.ui.locale.get());
  const off = [
    host.settings.registerPage({
      id: "web-search",
      packageId: "web-search",
      label: copy.title,
      group: "Engineering",
      icon: "telescope",
      order: 36,
      component: () => createElement(WebSearchSettingsPage, { host }),
      settingsItems: [
        { id: "web-search.enabled", pageId: "web-search", label: copy.enabled, description: copy.enabledDescription, keywords: ["web", "search", "internet", "enable"], focusTarget: "web-search.enabled" },
        { id: "web-search.provider", pageId: "web-search", label: copy.provider, description: copy.providerDescription, keywords: ["duckduckgo", "tavily", "provider"], focusTarget: "web-search.provider" },
        { id: "web-search.credential", pageId: "web-search", label: copy.credential, description: copy.credentialDescription, keywords: ["credential", "vault", "tavily", "api key"], focusTarget: "web-search.credential" },
      ],
    }),
    host.capabilities.register({
      id: "web-search",
      label: copy.title,
      plainDescription: copy.description,
      keywords: ["web", "search", "internet", "research", "duckduckgo", "tavily"],
      standardTier: "more",
      standardRank: 18,
      open: () => host.navigation.openSettingsPage("web-search"),
      available: () => true,
    }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
