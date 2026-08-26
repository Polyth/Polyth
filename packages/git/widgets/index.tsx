import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import GitView from "./GitView.tsx";
import PendingChangesBar from "./PendingChangesBar.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.surfaces.register({ id: "git", title: "Source control", shortLabel: "Git", capabilityId: "git", order: 2, component: GitView, presentation: { kind: "workspace", defaultRatio: 0.4, minWidth: 340, preferredMaxWidth: 640, keepAlive: true, escape: "close" } }),
    host.capabilities.register({ id: "git", label: "Source control", technicalLabel: "Git", plainDescription: "Review and manage changes to the code.", keywords: ["git", "worktrees", "branch", "diff", "changes"], standardTier: "technical", standardRank: 30, open: () => { host.navigation.openWorkspacePane("git"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "git", name: "Git", widgets: [{ id: "git.pending-changes", title: "Workspace files changed", description: "Show changed files for the active worktree.", kind: "mini-widget", defaultSlot: "session.footer", supportedSlots: ["session.footer"], defaultVisible: true, requiredVisible: true, order: 10, render: () => createElement(PendingChangesBar) }, { id: "git.recent", title: "Recent changes", description: "Review source-control status, diffs, and commits.", defaultSlot: "workspace.right", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 5, h: 4 }, render: () => createElement(GitView) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
