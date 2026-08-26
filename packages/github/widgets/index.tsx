import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import GithubView from "./GithubView.tsx";
import { GITHUB_WIDGET_PLUGIN } from "./githubPlugin.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.workspaceSurfaces.register({ id: "github", title: "GitHub", order: 26, plugin: "github", requires: "project", component: () => createElement(GithubView) }),
    host.capabilities.register({ id: "github", label: "GitHub", plainDescription: "Browse issues and pull requests for this project.", keywords: ["github", "issues", "pull requests", "pr"], standardTier: "more", standardRank: 16, open: () => host.navigation.setActiveView("github"), available: () => true }),
    host.widgets.registerPlugin(GITHUB_WIDGET_PLUGIN),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
