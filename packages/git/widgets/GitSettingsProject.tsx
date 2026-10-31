// Settings → Source control → This project: the active repository at a
// glance, who its commits come from and how Git reaches its remote. Provider
// packages add their own facts through `settings.integrations.project`.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SourceControlRemote } from "@polyth/contracts/source-control";
import type { WebPackageHost } from "@polyth/web-sdk";
import { api, type GitStatus } from "@polyth/session/web-api";
import { Button } from "../../../apps/web/src/components/ui/index.ts";
import {
  EmptyState, ErrorState, ItemList, ItemRow, PackageGlyph, ReadonlyRow, Section,
} from "../../../apps/web/src/components/settings/parts.tsx";
import { openWorkspacePane, setOverlay, useStore } from "../../../apps/web/src/store.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import SourceControlAuthGuide from "./SourceControlAuthGuide.tsx";
import SourceControlAccountSetting from "./SourceControlAccountSetting.tsx";
import { ProjectIdentityRows } from "./SourceControlProfilesSettings.tsx";
import { useSourceControlIdentity } from "./useSourceControlIdentity.ts";
import { usePersonGitProfile } from "./personGitProfile.ts";
import {
  peekRepositorySourceControlRemote,
  repositorySourceControlRemote,
  subscribeRepositorySourceControlRemotes,
} from "./sourceControlRemote.ts";

/** The repository's selected remote: undefined while reading, null for none
 *  (or one Polyth refuses to use). */
function useRepositoryRemote(projectId: string): SourceControlRemote | null | undefined {
  const [refused, setRefused] = useState<string | null>(null);
  const remote = useSyncExternalStore(
    subscribeRepositorySourceControlRemotes,
    () => peekRepositorySourceControlRemote(projectId),
  );
  useEffect(() => {
    let live = true;
    setRefused(null);
    void repositorySourceControlRemote(projectId).catch(() => { if (live) setRefused(projectId); });
    return () => { live = false; };
  }, [projectId]);
  return refused === projectId ? null : remote;
}

function changesText(status: GitStatus): string {
  const count = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;
  const changes = count === 0 ? tr("gitsettings.noChanges") : count === 1 ? tr("gitsettings.oneChange") : tr("gitsettings.manyChanges", { count });
  const sync = status.ahead === 0 && status.behind === 0
    ? tr("gitsettings.upToDate")
    : tr("gitsettings.aheadBehindValue", { ahead: status.ahead, behind: status.behind });
  return `${changes} · ${sync}`;
}

/** Owner: the identity the checkout's Git config carries. Everyone else:
 *  their own commit identity, changed on the Accounts tab. */
function CommitsSection({ projectId, owner, onShowPerson }: { projectId: string; owner: boolean; onShowPerson: () => void }) {
  const person = usePersonGitProfile();
  if (owner) return <OwnerCommits projectId={projectId} />;
  const profile = person.status === "ready" ? person.dto.profile : null;
  return (
    <Section title={tr("gitsettings.commitsTitle")} hint={tr("gitsettings.commitsHintMember")} itemId="git.projectIdentity">
      <ReadonlyRow
        label={tr("gitsettings.commitsAs")}
        hint={tr("gitsettings.commitsAsHint")}
        value={profile ? `${profile.name} · ${profile.email}` : tr("gitsettings.notSet")}
        action={<Button size="sm" variant="quiet" onClick={onShowPerson}>{profile ? tr("gitsettings.change") : tr("gitsettings.setIdentity")}</Button>}
      />
    </Section>
  );
}

function OwnerCommits({ projectId }: { projectId: string }) {
  const identity = useSourceControlIdentity(projectId);
  return (
    <Section title={tr("gitsettings.commitsTitle")} hint={tr("gitsettings.commitsHintOwner")}>
      <ProjectIdentityRows projectId={projectId} identity={identity} label={tr("gitsettings.identityRow")} />
    </Section>
  );
}

export default function GitSettingsProject({ host, projectId, owner, spaceAdmin, onShowAccounts }: {
  host: WebPackageHost;
  projectId: string;
  /** Instance owner: may write the checkout's own Git identity. */
  owner: boolean;
  /** Space admin: may bind the project to one of the Space's accounts. */
  spaceAdmin: boolean;
  /** Switches to the Accounts tab (your commit identity leads it). */
  onShowAccounts: () => void;
}) {
  const project = useStore((s) => s.projectRegistry.projects.find((candidate) => candidate.id === projectId) ?? null);
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const remote = useRepositoryRemote(projectId);
  useEffect(() => {
    let live = true;
    setStatus(undefined);
    setLoadError(null);
    void api.gitStatus(projectId)
      .then((next) => { if (live) setStatus(next); })
      .catch((cause: unknown) => { if (live) { setStatus(null); setLoadError(cause); } });
    return () => { live = false; };
  }, [projectId, reload]);

  if (status === undefined) return <EmptyState compact busy title={tr("gitsettings.repoChecking")} />;
  if (loadError) return <ErrorState title={tr("gitsettings.repoLoadError")} error={loadError} onRetry={() => setReload((n) => n + 1)} />;
  if (!status || status.isRepo === false || (status.isRepo === undefined && !status.branch)) {
    return <EmptyState icon="git" title={tr("gitsettings.notRepoTitle")} body={tr("gitsettings.notRepoBody")} />;
  }

  return (
    <>
      <div className="git-settings-repository" data-settings-item="git.repository">
        <ItemList label={project?.name ?? tr("gitsettings.tabProject")}>
          <ItemRow
            icon={<PackageGlyph icon="git" size={20} />}
            title={project?.name ?? tr("gitsettings.tabProject")}
            meta={<code className="git-settings-branch">{status.branch ?? tr("gitsettings.detachedHead")}</code>}
            description={changesText(status)}
            trailing={<Button size="sm" variant="quiet" onClick={() => { setOverlay(null); openWorkspacePane("git"); }}>{tr("gitsettings.openSourceControl")}</Button>}
          />
        </ItemList>
      </div>
      <CommitsSection projectId={projectId} owner={owner} onShowPerson={onShowAccounts} />
      <SourceControlAuthGuide remote={remote} onShowAccounts={onShowAccounts}>
        {spaceAdmin && <SourceControlAccountSetting projectId={projectId} />}
      </SourceControlAuthGuide>
      <host.ui.Slot slot="settings.integrations.project" context={{ projectId }} />
    </>
  );
}
