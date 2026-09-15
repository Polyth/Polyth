import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  type SourceControlProfile,
} from "@polyth/contracts/source-control";
import type { WebPackageHost } from "@polyth/web-sdk";
import { Button, Menu, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { useSourceControlIdentity } from "./useSourceControlIdentity.ts";

const providerLabel = (profile: SourceControlProfile): string => {
  if (profile.provider === "github") return "GitHub";
  if (profile.provider === "gitlab") return "GitLab";
  return "Git";
};

const authLabel = (profile: SourceControlProfile | null): string => {
  if (!profile) return "System Git environment";
  switch (profile.authentication.mode) {
    case "provider-cli": return "Provider CLI";
    case "ssh-agent": return "SSH agent";
    case "credential-helper": return "Git credential helper";
    case "managed": return "Managed provider account";
    default: return "System Git";
  }
};

export default function SourceControlIdentity({ host, projectId }: { host: WebPackageHost; projectId: string }) {
  const {
    stored,
    currentIdentity,
    resolution,
    syncing,
    error,
    selectProfile,
  } = useSourceControlIdentity(projectId);

  const profile = resolution.profile;
  const label = resolution.ok ? profile?.label ?? "System Git" : profile?.label ?? "Profile unavailable";
  const displayLabel = profile ? `${providerLabel(profile)} · ${label}` : label;
  const commitAuthor = resolution.ok ? resolution.commitAuthor : currentIdentity;
  const inherited = !stored.repositoryProfileIds[projectId];

  const entries: MenuEntry[] = [
    {
      id: "system-git",
      label: "System Git",
      detail: "SSH agent, credential helper and repository Git config",
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
        label: "Use inherited default",
        detail: stored.globalDefaultProfileId ? "Global source control default" : "System Git",
        disabled: syncing,
        onSelect: () => selectProfile(null),
      } satisfies MenuEntry,
    ] : []),
    "separator",
    {
      id: "manage",
      label: "Manage source control profiles",
      onSelect: () => host.navigation.openSettingsPage("git"),
    },
  ];

  return (
    <div className="source-control-identity">
      <Menu
        title="Source control profile"
        label="Source control profile"
        entries={entries}
        footer={(
          <div className="source-control-identity-details">
            <div><strong>{displayLabel}</strong>{inherited && <span className="muted">Inherited</span>}</div>
            {profile?.host && <small>{profile.host}{profile.username ? ` · @${profile.username}` : profile.account ? ` · ${profile.account}` : ""}</small>}
            {commitAuthor && <small>{commitAuthor.name} · {commitAuthor.email}</small>}
            <small>{authLabel(profile)}</small>
            {!resolution.ok && <small role="alert">This repository profile is unavailable or does not match its repository host.</small>}
            <host.ui.Slot slot="git.repository.identity.provider" context={{
              projectId,
              sourceControlProfileId: profile?.id ?? SYSTEM_SOURCE_CONTROL_PROFILE_ID,
              sourceControlProvider: resolution.provider,
              resolutionSource: resolution.source,
            }} />
            {syncing && <small role="status">Applying repository identity…</small>}
            {error && <small role="alert">{error}</small>}
          </div>
        )}
      >
        {(trigger) => (
          <Button
            {...trigger}
            size="sm"
            variant="ghost"
            className="source-control-identity-trigger"
            disabled={syncing}
            title={displayLabel}
          >
            {displayLabel}
          </Button>
        )}
      </Menu>
    </div>
  );
}
