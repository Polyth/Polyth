import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import GithubView from "./GithubView.tsx";
import { GITHUB_WIDGET_PLUGIN } from "./githubPlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "github", title: "GitHub", description: "Browse issues and pull requests for this project.", capabilityId: "github", order: 26, component: () => createElement(GithubView), presentation: { kind: "workspace", defaultRatio: 0.6, minWidth: 380, preferredMaxWidth: 760, keepAlive: false, escape: "close" } }),
    host.capabilities.register({ id: "github", label: "GitHub", plainDescription: "Browse issues and pull requests for this project.", keywords: ["github", "issues", "pull requests", "pr"], standardTier: "more", standardRank: 16, open: () => host.navigation.openWorkspacePane("github"), available: () => true }),
    host.widgets.registerPlugin(GITHUB_WIDGET_PLUGIN),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
