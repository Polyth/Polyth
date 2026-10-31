import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  type SourceControlProfile,
} from "@polyth/contracts/source-control";
import type { WebPackageHost } from "@polyth/web-sdk";
import { Button, ChevronDownIcon, Menu, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useSourceControlIdentity } from "./useSourceControlIdentity.ts";
import { mayWriteCheckoutIdentity, usePersonGitProfile } from "./personGitProfile.ts";
import { PERSON_ACCOUNTS_ITEM, PERSON_PROFILE_ITEM } from "./gitRefusal.ts";

const providerLabel = (profile: SourceControlProfile): string => {
  if (profile.provider === "github") return "GitHub";
  if (profile.provider === "gitlab") return "GitLab";
  return "Git";
};

export default function SourceControlIdentity({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const person = usePersonGitProfile();
  // Checkout identities write the shared checkout's Git config: the instance
  // owner's. Everyone else commits with their own profile (Spaces §14.4).
  if (person.status === "ready" && !mayWriteCheckoutIdentity(person)) {
    return <PersonCommitIdentity host={host} projectId={projectId} profile={person.dto.profile} />;
  }
  return <CheckoutIdentity host={host} projectId={projectId} />;
}

/** A member's chip: whose name their commits carry, and where to change it or
 *  connect the accounts their pushes use. */
function PersonCommitIdentity({ host, projectId, profile }: {
  host: WebPackageHost;
  projectId: string;
  profile: { name: string; email: string } | null;
}) {
  const label = profile ? profile.name : tr("gitreg.setCommitIdentity");
  const entries: MenuEntry[] = [
    {
      id: "profile",
      label: profile ? tr("gitreg.changeIdentity") : tr("gitreg.setYourIdentity"),
      detail: profile ? `${profile.name} · ${profile.email}` : tr("gitreg.identityRule"),
      onSelect: () => host.navigation.openSettingsPage("git", { itemId: PERSON_PROFILE_ITEM }),
    },
    {
      id: "accounts",
      label: tr("gitreg.accountsEntry"),
      detail: tr("gitreg.accountsEntryDetail"),
      onSelect: () => host.navigation.openSettingsPage("git", { itemId: PERSON_ACCOUNTS_ITEM }),
    },
  ];
  return (
    <div className="source-control-identity" data-identity-owner="person">
      <Menu
        title={tr("gitview.identityAndProviderAccounts")}
        label={tr("gitview.chooseCommitIdentity")}
        entries={entries}
        footer={(
          <>
            <div className="ui-separator ui-separator--horizontal" role="separator" />
            <div className="source-control-identity-details">
              <div><strong>{profile ? tr("gitreg.yourIdentity") : tr("gitreg.noIdentity")}</strong></div>
              {profile
                ? <small><span className="source-control-detail-label">{tr("gitprojectsource.commitAs")}</span> {profile.name} · {profile.email}</small>
                : <small role="status">{tr("gitreg.noIdentityNote")}</small>}
              <div className="source-control-provider-summary" aria-label={tr("gitview.providerAccounts")}>
                <host.ui.Slot slot="git.repository.identity.provider" context={{ projectId }} />
              </div>
            </div>
          </>
        )}
      >
        {(trigger) => (
          <Button
            {...trigger}
            size="sm"
            variant="ghost"
            iconEnd={ChevronDownIcon}
            className="source-control-identity-trigger"
            data-attention={profile ? undefined : "true"}
            title={profile ? `${profile.name} · ${profile.email}` : label}
            aria-label={tr("gitview.currentCommitIdentity", { identity: label })}
          >
            <span className="source-control-identity-value">{label}</span>
            <span className="source-control-identity-compact-label">{tr("gitview.identity")}</span>
          </Button>
        )}
      </Menu>
    </div>
  );
}

function CheckoutIdentity({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const {
    stored,
    currentIdentity,
    resolution,
    syncing,
    error,
    selectProfile,
  } = useSourceControlIdentity(projectId);

  const profile = resolution.profile;
  const label = resolution.ok ? profile?.label ?? tr("gitprojectsource.systemGit") : profile?.label ?? tr("gitreg.profileUnavailable");
  const displayLabel = profile ? `${providerLabel(profile)} · ${label}` : label;
  const provider = resolution.provider === "github" ? "GitHub" : resolution.provider === "gitlab" ? "GitLab" : "Git";
  const triggerLabel = !profile && resolution.provider !== "generic"
    ? tr("gitview.identityAndProvider", { identity: label, provider }) : displayLabel;
  const commitAuthor = resolution.ok ? resolution.commitAuthor : currentIdentity;
  const inherited = !stored.repositoryProfileIds[projectId];

  const entries: MenuEntry[] = [
    {
      id: "system-git",
      label: tr("gitprojectsource.systemGit"),
      detail: tr("gitreg.systemGitDetail"),
      kind: "radio",
      checked: (resolution.ok && !resolution.profile && resolution.source === "system")
        || stored.repositoryProfileIds[projectId] === SYSTEM_SOURCE_CONTROL_PROFILE_ID,
      disabled: syncing,
      onSelect: () => selectProfile(SYSTEM_SOURCE_CONTROL_PROFILE_ID),
    },
    ...stored.profiles.map((row): MenuEntry => ({
      id: row.id,
      label: row.label,
      detail: [providerLabel(row), row.host, row.username ? `@${row.username}` : row.account].filter(Boolean).join(" · "),
      kind: "radio",
      checked: resolution.ok && resolution.profile?.id === row.id,
      disabled: syncing,
      onSelect: () => selectProfile(row.id),
    })),
    ...(stored.repositoryProfileIds[projectId] ? [
      "separator" as const,
      {
        id: "inherit",
        label: tr("gitidentity.useDefault"),
        detail: stored.profiles.find((row) => row.id === stored.globalDefaultProfileId)?.label ?? tr("gitprojectsource.systemGit"),
        disabled: syncing,
        onSelect: () => selectProfile(null),
      } satisfies MenuEntry,
    ] : []),
    "separator",
    {
      id: "manage",
      label: tr("gitreg.manageAccess"),
      detail: tr("gitreg.manageAccessDetail"),
      onSelect: () => host.navigation.openSettingsPage("git", { itemId: "git.sourceControlProfiles" }),
    },
    {
      id: "manage-hosting",
      label: tr("gitreg.manageProviders"),
      detail: tr("gitreg.manageProvidersDetail"),
      onSelect: () => host.navigation.openSettingsPage("git"),
    },
  ];

  return (
    <div className="source-control-identity">
      <Menu
        title={tr("gitview.identityAndProviderAccounts")}
        label={tr("gitview.chooseCommitIdentity")}
        entries={entries}
        footer={(
          <>
            <div className="ui-separator ui-separator--horizontal" role="separator" />
            <div className="source-control-identity-details">
              <div><strong>{displayLabel}</strong><span className="muted">{inherited ? tr("gitidentity.fromDefault") : tr("gitidentity.thisProject")}</span></div>
              {commitAuthor && <small><span className="source-control-detail-label">{tr("gitprojectsource.commitAs")}</span> {commitAuthor.name} · {commitAuthor.email}</small>}
              {!resolution.ok && <small role="alert">{tr("gitreg.identityMismatch")}</small>}
              {syncing && <small role="status">{tr("gitsettings.applyingIdentity")}</small>}
              {error && <small role="alert">{error}</small>}
              <div className="source-control-provider-summary" aria-label={tr("gitview.providerAccounts")}>
                <host.ui.Slot slot="git.repository.identity.provider" context={{
                  projectId,
                  sourceControlProfileId: profile?.id ?? SYSTEM_SOURCE_CONTROL_PROFILE_ID,
                  sourceControlProvider: resolution.provider,
                  resolutionSource: resolution.source,
                }} />
              </div>
            </div>
          </>
        )}
      >
        {(trigger) => (
          <Button
            {...trigger}
            size="sm"
            variant="ghost"
            iconEnd={ChevronDownIcon}
            className="source-control-identity-trigger"
            disabled={syncing}
            title={displayLabel}
            aria-label={tr("gitview.currentCommitIdentity", { identity: triggerLabel })}
          >
            <span className="source-control-identity-value">{triggerLabel}</span>
            <span className="source-control-identity-compact-label">{tr("gitview.identity")}</span>
          </Button>
        )}
      </Menu>
    </div>
  );
}
