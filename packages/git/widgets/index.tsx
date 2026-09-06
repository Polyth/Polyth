import "./styles.css";
import { createElement } from "react";
import { defineWebPackage } from "@polyth/web-sdk";
import GitSettings from "./GitSettings.tsx";
import GitView from "./GitView.tsx";
import PendingChangesBar from "./PendingChangesBar.tsx";
import GitProjectSource from "./GitProjectSource.tsx";
import { IsolationBadge, IsolationCard, IsolationListBadge } from "./IsolationCard.tsx";

export default defineWebPackage((host) => () => {
  const off = [
    host.settings.registerPage({ id: "git", packageId: "git", label: "Git", group: "Engineering", icon: "⎇", order: 30, component: GitSettings }),
    host.slots.register({ slot: "project.create.options", id: "git-clone-project", order: 20, render: (props) => createElement(GitProjectSource, props) }),
    host.slots.register({ slot: "session.timeline.after", id: "git-isolation-card", order: 20, render: () => createElement(IsolationCard) }),
    host.slots.register({ slot: "session.header.actions", id: "git-isolation-badge", order: 15, render: () => createElement(IsolationBadge) }),
    host.slots.register({
      slot: "session.list.badges",
      id: "git-isolation-list-badge",
      order: 20,
      render: (props) => createElement(IsolationListBadge, {
        sessionId: typeof props.sessionId === "string" ? props.sessionId : "",
      }),
    }),
    host.surfaces.register({ id: "git", title: "Source control", description: "Review and manage changes to the code.", shortLabel: "Git", capabilityId: "git", order: 2, component: GitView, badge: (ctx) => ctx.changeCount, presentation: { kind: "workspace", defaultRatio: 0.4, minWidth: 340, preferredMaxWidth: 640, keepAlive: true, escape: "close" } }),
    host.capabilities.register({ id: "git", label: "Source control", technicalLabel: "Git", plainDescription: "Review and manage changes to the code.", keywords: ["git", "worktrees", "branch", "diff", "changes"], standardTier: "technical", standardRank: 30, open: () => { host.navigation.openWorkspacePane("git"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "git", name: "Git", widgets: [{ id: "git.pending-changes", title: "Workspace files changed", description: "Show changed files for the active worktree.", kind: "mini-widget", defaultSlot: "session.footer", supportedSlots: ["session.footer", "composer.pending", "composer.meta", "session.composer.before", "workspace.right", "workspace.bottom"], defaultVisible: true, requiredVisible: true, recommended: true, order: 10, render: () => createElement(PendingChangesBar) }, { id: "git.recent", title: "Recent changes", description: "Review source-control status, diffs, and commits.", defaultSlot: "workspace.right", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 5, h: 4 }, render: () => createElement(GitView) }] }),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
