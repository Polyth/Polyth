import "./styles.css";
import "./mobile.css";
import "./source-control-polish.css";
import { createElement } from "react";
import { resolveSourceControlContext } from "@polyth/contracts/source-control";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import GitSettings from "./GitSettings.tsx";
import GitView from "./GitView.tsx";
import PendingChangesBar from "./PendingChangesBar.tsx";
import RecentChangesWidget from "./RecentChangesWidget.tsx";
import GitProjectSource from "./GitProjectSource.tsx";
import SourceControlIdentity from "./SourceControlIdentity.tsx";
import { IsolationBadge, IsolationCard, IsolationListBadge } from "./IsolationCard.tsx";
import {
  gitContextSnapshot,
  peekGitStatus,
  refreshGitStatus,
  subscribeGitStatus,
} from "./gitStatusStore.ts";
import {
  getSourceControlProfileState,
  subscribeSourceControlProfiles,
} from "./sourceControlProfiles.ts";
import {
  peekRepositorySourceControlRemote,
  subscribeRepositorySourceControlRemotes,
} from "./sourceControlRemote.ts";
import { reconcileSourceControlIdentity } from "./sourceControlRuntime.ts";

export default defineWebPackage((host) => () => {
  // The store notifies on every applied event batch, so an unfiltered listener
  // ran a status fetch plus a full identity reconcile (remotes + identity, and
  // possibly an identity write) per streamed batch. Only a project switch needs
  // that; live status freshness is the pollers' job in useGitStatus. Profile
  // edits force a run because the resolved identity, not the project, changed.
  let scope = "";
  const refreshActive = (force = false) => {
    const projectId = host.store.getSnapshot().activeProjectId;
    if (!projectId || (projectId === scope && !force)) return;
    scope = projectId;
    void refreshGitStatus(projectId);
    void reconcileSourceControlIdentity(projectId).catch(() => undefined);
  };
  refreshActive();
  const off = [
    host.settings.registerPage({ id: "git", packageId: "git", label: "Source Control", group: "Engineering", icon: "git", order: 30, component: GitSettings }),
    host.slots.register({ slot: "project.create.options", id: "git-clone-project", order: 20, render: (props) => createElement(GitProjectSource, { ...props, host }) }),
    host.slots.register({ slot: "git.repository.identity", id: "git.source-control-identity", order: 5, render: (props) => typeof props.projectId === "string" ? createElement(SourceControlIdentity, { host, projectId: props.projectId }) : null }),
    host.slots.register({ slot: "git.repository.identity", id: "git.change-request-state", order: 15, render: (props) => <host.ui.Slot slot="git.repository.change-request.provider" context={props} /> }),
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
    host.surfaces.register({ id: "git", title: "Source control", description: "Review and manage changes to the code.", shortLabel: "Git", capabilityId: "git", order: 2, component: () => <GitView host={host} />, badge: (ctx) => ctx.changeCount, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.4, minWidth: 340, preferredMaxWidth: 640, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "git", label: "Source control", technicalLabel: "Git", plainDescription: "Review and manage changes to the code.", keywords: ["git", "worktrees", "branch", "diff", "changes"], standardTier: "technical", standardRank: 30, open: () => { host.navigation.openWorkspacePane("git"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "git", name: "Git", widgets: [{ id: "git.pending-changes", title: "Workspace files changed", description: "Show changed files for the active worktree.", kind: "mini-widget", defaultSlot: "session.footer", supportedSlots: ["session.footer", "composer.pending", "composer.meta", "session.composer.before", "workspace.right", "workspace.bottom"], defaultVisible: true, requiredVisible: true, recommended: true, order: 10, render: () => createElement(PendingChangesBar) }, { id: "git.recent", title: "Recent changes", description: "Branch, sync state, and changed files, with a link into Source control.", defaultSlot: "workspace.right", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 5, h: 4 }, minSize: { w: 3, h: 3 }, render: (context) => createElement(RecentChangesWidget, { projectId: context.projectId, sessionId: context.sessionId }) }] }),
    host.projectContext.register({
      id: "git",
      order: 2,
      getSnapshot: (projectId) => {
        const profiles = getSourceControlProfileState();
        const resolution = resolveSourceControlContext({
          profiles: profiles.profiles,
          remote: peekRepositorySourceControlRemote(projectId),
          repositoryProfileId: profiles.repositoryProfileIds[projectId],
          globalProfileId: profiles.globalDefaultProfileId,
        });
        const sourceControl = resolution.ok ? {
          label: resolution.profile?.label ?? "System Git",
          provider: resolution.provider,
          source: resolution.source,
        } : {
          label: "Profile unavailable",
          provider: resolution.provider,
          source: resolution.source,
        };
        return gitContextSnapshot(peekGitStatus(projectId), sourceControl);
      },
      subscribe: (listener) => {
        const offGit = subscribeGitStatus(listener);
        const offProfiles = subscribeSourceControlProfiles(listener);
        const offRemotes = subscribeRepositorySourceControlRemotes(listener);
        return () => { offGit(); offProfiles(); offRemotes(); };
      },
    }),
    host.store.subscribe(() => refreshActive()),
    subscribeSourceControlProfiles(() => refreshActive(true)),
  ];
  return () => off.toReversed().forEach((dispose) => dispose());
});
