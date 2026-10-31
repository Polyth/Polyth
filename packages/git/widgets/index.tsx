import "./styles.css";
import "./source-control.css";
import "./source-control-settings.css";
import { createElement } from "react";
import { resolveSourceControlContext } from "@polyth/contracts/source-control";
import type { SessionStatus } from "@polyth/contracts";
import { defineWebPackage } from "@polyth/web-sdk";
import { withSurfaceContent } from "@polyth/web-sdk/surface-content";
import GitSettings from "./GitSettings.tsx";
import GitView from "./GitView.tsx";
import PendingChangesBar from "./PendingChangesBar.tsx";
import RecentChangesWidget from "./RecentChangesWidget.tsx";
import GitProjectSource from "./GitProjectSource.tsx";
import SourceControlIdentity from "./SourceControlIdentity.tsx";
import ProjectGitIdentity from "./ProjectGitIdentity.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { IsolationCard, IsolationListBadge, IsolationLock } from "./IsolationCard.tsx";
import { IsolationMenuAction } from "./IsolationMenuAction.tsx";
import { IsolationBulkAction, type BulkReport } from "./IsolationBulkAction.tsx";
import {
  gitContextSnapshot,
  peekGitStatus,
  refreshGitStatus,
  subscribeGitStatus,
} from "./gitStatusStore.ts";
import {
  getSourceControlProfileState,
  replaceSourceControlProfileState,
  subscribeSourceControlProfiles,
} from "./sourceControlProfiles.ts";
import {
  peekRepositorySourceControlRemote,
  subscribeRepositorySourceControlRemotes,
} from "./sourceControlRemote.ts";
import { reconcileSourceControlIdentity } from "./sourceControlRuntime.ts";
import { getGitPrefs, replaceGitPrefs, subscribeGitPrefs } from "./gitPrefs.ts";

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
    host.preferences.register("package.git.preferences", {
      read: () => getGitPrefs(),
      write: replaceGitPrefs,
      subscribe: subscribeGitPrefs,
    }),
    host.preferences.register("package.git.profiles", {
      // Profiles and the global default are account-wide. Project-to-profile
      // mappings and learned identities stay local to avoid crossing the
      // project/Space boundary in the account settings blob.
      read: () => {
        const state = getSourceControlProfileState();
        return { profiles: state.profiles, globalDefaultProfileId: state.globalDefaultProfileId };
      },
      write: (value) => {
        const current = getSourceControlProfileState();
        const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
        replaceSourceControlProfileState({
          ...current,
          profiles: raw.profiles,
          globalDefaultProfileId: raw.globalDefaultProfileId,
        });
      },
      subscribe: subscribeSourceControlProfiles,
    }),
    host.settings.registerItems([
      { id: "git.personProfile", pageId: "git", label: tr("gitsettings.personTitle"), description: tr("gitsettings.personHintSet"), keywords: ["commit", "author", "name", "email", "identity", "profile"], focusTarget: "git.personProfile" },
      { id: "git.personAccounts", pageId: "git", label: tr("gitsettings.searchAccounts"), description: tr("gitsettings.searchAccountsHint"), keywords: ["github", "gitlab", "account", "token", "pat", "push", "credentials", "sign in"], focusTarget: "git.personAccounts" },
      { id: "git.sourceControlProfiles", pageId: "git", label: tr("gitidentity.sectionTitle"), description: tr("gitsettings.searchIdentitiesHint"), keywords: ["identity", "identities", "signing", "ssh", "key", "profile", "owner"], focusTarget: "git.sourceControlProfiles" },
      { id: "git.defaultIdentity", pageId: "git", label: tr("gitidentity.defaultIdentity"), description: tr("gitidentity.defaultIdentityHint"), keywords: ["commit", "author", "identity", "default", "global"], focusTarget: "git.defaultIdentity" },
      { id: "git.projectIdentity", pageId: "git", label: tr("gitsettings.searchProjectIdentity"), description: tr("gitidentity.projectIdentityHint"), keywords: ["commit", "author", "identity", "project", "signing", "ssh", "account"], focusTarget: "git.projectIdentity" },
      { id: "git.authentication", pageId: "git", label: tr("gitsettings.access"), description: tr("gitsettings.accessHint"), keywords: ["ssh", "https", "remote", "credential", "helper", "key", "sign in", "push", "fetch"], focusTarget: "git.authentication" },
      { id: "git.commitMessageModel", pageId: "git", label: tr("gitsettings.commitMessages"), description: tr("gitsettings.commitModelHint"), keywords: ["commit", "message", "integration", "model", "small"], focusTarget: "git.commitMessageModel" },
      { id: "git.branchTemplate", pageId: "git", label: tr("gitsettings.branchesTitle"), description: tr("gitsettings.branchesHint"), keywords: ["branch", "name", "template", "worktree", "slug", "prefix"], focusTarget: "git.branchTemplate" },
      { id: "git.conflictAgentTarget", pageId: "git", label: tr("gitsettings.conflictsTitle"), description: tr("gitsettings.conflictsHint"), keywords: ["merge", "conflict", "resolve", "agent", "prompt", "session"], focusTarget: "git.conflictAgentTarget" },
      { id: "git.display", pageId: "git", label: tr("gitsettings.searchDisplay"), description: tr("gitsettings.searchDisplayHint"), keywords: ["tree", "list", "density", "diff", "split", "unified", "wrap", "whitespace", "graph", "dates", "line counts"], focusTarget: "git.display" },
      { id: "git.servicePolicy", pageId: "git", label: tr("gitsettings.spacePolicyTitle"), description: tr("gitsettings.agentsMayUse"), keywords: ["service", "shared", "agents", "space", "policy", "account"], focusTarget: "git.servicePolicy" },
    ]),
    host.settings.registerPage({ id: "git", packageId: "git", label: tr("gitreg.sourceControl"), group: "Engineering", icon: "git", order: 30, component: ({ settingsTarget }) => <GitSettings host={host} {...(settingsTarget ? { settingsTarget } : {})} /> }),
    host.projectSettings.register({
      id: "git.identity",
      order: 30,
      label: tr("gitidentity.projectPageLabel"),
      description: tr("gitidentity.projectPageDescription"),
      icon: "git",
      render: ({ project, onBack }) => <ProjectGitIdentity host={host} project={project} onBack={onBack} />,
    }),
    host.slots.register({ slot: "project.create.options", id: "git-clone-project", order: 20, render: (props) => createElement(GitProjectSource, { ...props, host }) }),
    host.slots.register({ slot: "git.repository.identity", id: "git.source-control-identity", order: 5, render: (props) => typeof props.projectId === "string" ? createElement(SourceControlIdentity, { host, projectId: props.projectId }) : null }),
    host.slots.register({ slot: "git.repository.identity", id: "git.change-request-state", order: 15, render: (props) => <host.ui.Slot slot="git.repository.change-request.provider" context={props} /> }),
    host.slots.register({ slot: "session.timeline.after", id: "git-isolation-card", order: 20, render: () => createElement(IsolationCard) }),
    host.slots.register({ slot: "session.header.status", id: "git-isolation-lock", order: 15, render: () => createElement(IsolationLock) }),
    host.slots.register({
      slot: "sidebar.session.actions",
      id: "git-isolation-finish",
      order: 20,
      render: ({ sessionId, status, closeMenu }) => typeof sessionId === "string"
        ? createElement(IsolationMenuAction, {
          key: sessionId,
          sessionId,
          ...(typeof status === "string" ? { status: status as SessionStatus } : {}),
          ...(typeof closeMenu === "function" ? { closeMenu: closeMenu as () => void } : {}),
        })
        : null,
    }),
    host.slots.register({
      slot: "sidebar.sessions.bulk.actions",
      id: "git-isolation-leave-selected",
      order: 20,
      render: ({ sessionIds, closeMenu, done, report }) => Array.isArray(sessionIds)
        ? createElement(IsolationBulkAction, {
          sessionIds: sessionIds.filter((id): id is string => typeof id === "string"),
          ...(typeof closeMenu === "function" ? { closeMenu: closeMenu as () => void } : {}),
          ...(typeof done === "function" ? { done: done as () => void } : {}),
          ...(typeof report === "function" ? { report: report as BulkReport } : {}),
        })
        : null,
    }),
    host.slots.register({
      slot: "session.list.badges",
      id: "git-isolation-list-badge",
      order: 20,
      render: (props) => createElement(IsolationListBadge, {
        sessionId: typeof props.sessionId === "string" ? props.sessionId : "",
      }),
    }),
    host.surfaces.register({ id: "git", title: tr("gitreg.sourceControl"), description: tr("gitreg.surfaceDescription"), shortLabel: "Git", capabilityId: "git", order: 2, component: (props) => <GitView {...props} host={host} />, badge: (ctx) => ctx.changeCount, presentation: withSurfaceContent({ kind: "workspace", defaultRatio: 0.4, minWidth: 340, preferredMaxWidth: 640, keepAlive: true, escape: "close" }, "workspace") }),
    host.capabilities.register({ id: "git", label: tr("gitreg.sourceControl"), technicalLabel: "Git", plainDescription: tr("gitreg.surfaceDescription"), keywords: ["git", "worktrees", "branch", "diff", "changes"], standardTier: "technical", standardRank: 3, defaultRails: { general: "right", engineering: "top" }, open: () => { host.navigation.openWorkspacePane("git"); }, available: () => true }),
    host.widgets.registerPlugin({ id: "git", name: "Git", widgets: [{ id: "git.pending-changes", title: tr("gitreg.pendingTitle"), description: tr("gitreg.pendingDescription"), kind: "mini-widget", defaultSlot: "session.footer", supportedSlots: ["session.footer", "composer.pending", "composer.meta", "session.composer.before", "workspace.right", "workspace.bottom"], defaultVisible: true, requiredVisible: true, recommended: true, order: 10, render: () => createElement(PendingChangesBar) }, { id: "git.recent", title: tr("gitreg.recentTitle"), description: tr("gitreg.recentDescription"), defaultSlot: "workspace.right", supportedSlots: ["workspace.left", "workspace.main", "workspace.right"], defaultSize: { w: 5, h: 4 }, minSize: { w: 3, h: 4 }, render: (context) => createElement(RecentChangesWidget, { projectId: context.projectId, sessionId: context.sessionId }) }] }),
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
          label: resolution.profile?.label ?? tr("gitprojectsource.systemGit"),
          provider: resolution.provider,
          source: resolution.source,
        } : {
          label: tr("gitreg.profileUnavailable"),
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
