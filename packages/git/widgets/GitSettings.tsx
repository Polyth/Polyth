// Settings → Source control. One page, five jobs, one tab each:
//   Accounts     — who you are on commits and the hosting accounts you push with
//   This project — the active repository: who commits, how Git signs in
//   Workflow     — what Polyth automates: commit messages, branch names, conflicts
//   Display      — how the Source control view lists changes, diffs and history
//   Space        — Space admins: the Space's shared accounts and their policy
// Deep links and search hits name a row (`itemId`) or a tab (`sectionId`);
// `gitSettingsTabFor` maps them so the row is on screen when the host looks.
import { useState, type ReactNode } from "react";
import type { SettingsNavigationTarget, WebPackageHost } from "@polyth/web-sdk";
import { useStore } from "../../../apps/web/src/store.ts";
import { PageHead, SettingsTabs } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import CommitMessageSettings from "./CommitMessageSettings.tsx";
import { RepositoryIdentities } from "./SourceControlProfilesSettings.tsx";
import PersonGitProfileSection from "./PersonGitProfileSection.tsx";
import SourceControlDisplaySettings from "./SourceControlDisplaySettings.tsx";
import SpaceServiceAccounts, { useSpaceAdmin } from "./SpaceServiceAccounts.tsx";
import GitSettingsProject from "./GitSettingsProject.tsx";
import GitSettingsWorkflow from "./GitSettingsWorkflow.tsx";
import { PERSON_ACCOUNTS_ITEM } from "./gitRefusal.ts";
import { mayWriteCheckoutIdentity, usePersonGitProfile } from "./personGitProfile.ts";

export type GitSettingsTab = "accounts" | "project" | "workflow" | "display" | "space";

const TABS: readonly GitSettingsTab[] = ["accounts", "project", "workflow", "display", "space"];

/** Every addressable row, by the tab that renders it. */
const TAB_BY_ITEM: Readonly<Record<string, GitSettingsTab>> = {
  "git.personProfile": "accounts",
  "git.personAccounts": "accounts",
  "git.sourceControlProfiles": "accounts",
  "git.defaultIdentity": "accounts",
  "git.repository": "project",
  "git.projectIdentity": "project",
  "git.sourceControlAccount": "project",
  "git.authentication": "project",
  "git.commitMessageModel": "workflow",
  "git.branchTemplate": "workflow",
  "git.conflictAgentTarget": "workflow",
  "git.conflictAgentPrompt": "workflow",
  "git.display": "display",
  "git.changesView": "display",
  "git.lineStats": "display",
  "git.density": "display",
  "git.diffLayout": "display",
  "git.wrap": "display",
  "git.ignoreWhitespace": "display",
  "git.logGraph": "display",
  "git.dateStyle": "display",
  "git.servicePolicy": "space",
  "git.spaceAccounts": "space",
};

/** The tab a settings target lands on: an explicit tab id in `sectionId`,
 *  else the tab that owns `itemId`. Null keeps the current tab. */
export function gitSettingsTabFor(target: SettingsNavigationTarget | undefined): GitSettingsTab | null {
  const section = target?.sectionId;
  if (section && (TABS as readonly string[]).includes(section)) return section as GitSettingsTab;
  const item = target?.itemId;
  return item ? TAB_BY_ITEM[item] ?? null : null;
}

/** Tab label with a quiet attention dot when something there blocks work. */
function TabLabel({ label, attention }: { label: string; attention?: string }) {
  return (
    <span className="git-settings-tab">
      {label}
      {attention && <span className="git-settings-tab-dot" role="img" aria-label={attention} />}
    </span>
  );
}

export default function GitSettings({ host, settingsTarget }: { host: WebPackageHost; settingsTarget?: SettingsNavigationTarget }) {
  const projectId = useStore((s) => s.activeProjectId);
  const spaceAdmin = useSpaceAdmin();
  const person = usePersonGitProfile();
  // The checkout's own Git config is the instance owner's (Spaces §14.4).
  const owner = person.status !== "loading" && mayWriteCheckoutIdentity(person);
  const identityMissing = person.status === "ready" && !person.dto.profile && !person.dto.usesInstallationFallback;

  const requested = gitSettingsTabFor(settingsTarget);
  const [tab, setTab] = useState<GitSettingsTab>(requested ?? "accounts");
  // A new target switches tabs in the same render, so the row is mounted by
  // the time the host scrolls to it.
  const [seenTarget, setSeenTarget] = useState(settingsTarget);
  if (settingsTarget !== seenTarget) {
    setSeenTarget(settingsTarget);
    if (requested && requested !== tab) setTab(requested);
  }

  const available: GitSettingsTab[] = [
    "accounts",
    ...(projectId ? ["project" as const] : []),
    "workflow",
    "display",
    ...(spaceAdmin ? ["space" as const] : []),
  ];
  // A tab that is not offered (no project, not an admin yet) shows Accounts;
  // the choice is kept, so an admin deep link opens once the role is known.
  const active = available.includes(tab) ? tab : "accounts";

  const labels: Record<GitSettingsTab, ReactNode> = {
    accounts: <TabLabel label={tr("gitsettings.tabAccounts")} {...(identityMissing ? { attention: tr("gitsettings.tabAccountsAttention") } : {})} />,
    project: <TabLabel label={tr("gitsettings.tabProject")} />,
    workflow: <TabLabel label={tr("gitsettings.tabWorkflow")} />,
    display: <TabLabel label={tr("gitsettings.tabDisplay")} />,
    space: <TabLabel label={tr("gitsettings.tabSpace")} />,
  };

  return (
    <div className="git-settings">
      <PageHead blurb={tr("gitsettings.pageBlurb")} />
      <SettingsTabs
        tabs={available.map((id) => ({ id, label: labels[id] }))}
        value={active}
        onChange={(id) => setTab(id as GitSettingsTab)}
        label={tr("gitsettings.tabsLabel")}
        idBase="git-settings"
      >
        {active === "accounts" && (
          <>
            <PersonGitProfileSection />
            {/* Each hosting provider contributes its own Section of the
                person's accounts ("GitHub", "GitLab"). */}
            <div className="git-provider-integrations" data-settings-item={PERSON_ACCOUNTS_ITEM}>
              <host.ui.Slot slot="settings.integrations" context={{ spaceAdmin, ...(projectId ? { projectId } : {}) }} />
            </div>
            {owner && <RepositoryIdentities />}
          </>
        )}
        {active === "project" && projectId && (
          <GitSettingsProject host={host} projectId={projectId} owner={owner} spaceAdmin={spaceAdmin} onShowAccounts={() => setTab("accounts")} />
        )}
        {active === "workflow" && (
          <>
            <CommitMessageSettings {...(projectId ? { projectId } : {})} />
            <GitSettingsWorkflow />
          </>
        )}
        {active === "display" && <SourceControlDisplaySettings />}
        {active === "space" && (
          <>
            <SpaceServiceAccounts />
            <div className="git-provider-integrations" data-settings-item="git.spaceAccounts">
              <host.ui.Slot slot="settings.integrations.space" context={{ spaceAdmin, ...(projectId ? { projectId } : {}) }} />
            </div>
          </>
        )}
      </SettingsTabs>
    </div>
  );
}
