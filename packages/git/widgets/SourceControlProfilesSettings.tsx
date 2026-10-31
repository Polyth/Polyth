import { useState } from "react";
import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  type SourceControlProfile,
} from "@polyth/contracts/source-control";
import { Badge, Button, IconButton, Menu, MoreIcon, Select, type MenuEntry } from "../../../apps/web/src/components/ui/index.ts";
import { ItemList, ItemRow, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { confirmAlert } from "../../../apps/web/src/alerts.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import SourceControlIdentityDialog, { authChoiceOf, blankIdentity } from "./SourceControlIdentityDialog.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import {
  removeSourceControlProfile,
  saveSourceControlProfile,
  setGlobalSourceControlProfile,
  setRepositorySourceControlProfile,
  useSourceControlProfileState,
} from "./sourceControlProfiles.ts";
import { useSourceControlIdentity } from "./useSourceControlIdentity.ts";

const INHERIT = "inherit";

const authorOf = (profile: SourceControlProfile): string =>
  profile.commitAuthor ? `${profile.commitAuthor.name} · ${profile.commitAuthor.email}` : tr("gitidentity.noAuthor");

/** Short facts about how an identity commits and signs in. */
export function identityFacts(profile: SourceControlProfile): string[] {
  const auth = authChoiceOf(profile.authentication.mode);
  return [
    auth === "account" && profile.hostingAccount ? tr("gitidentity.factAccount", { account: `@${profile.hostingAccount.login}` })
      : auth === "ssh" ? tr("gitidentity.factSsh", { key: profile.authentication.identityFile?.split("/").pop() ?? "" })
      : auth === "anonymous" ? tr("gitidentity.authAnonymous")
      : tr("gitidentity.authMachine"),
    ...(auth !== "account" && profile.hostingAccount ? [`@${profile.hostingAccount.login}`] : []),
    ...(profile.signingKey ? [tr("gitidentity.factSigned")] : []),
  ];
}

type Identity = ReturnType<typeof useSourceControlIdentity>;

/** Which identity a project commits with, and what that means right now.
 *  Shared by Settings → Source control → This project and the project's own
 *  settings page. */
export function ProjectIdentityRows({ projectId, identity, label }: {
  projectId: string;
  identity: Identity;
  /** Row label; the project page names the project, Settings says "Identity". */
  label?: string;
}) {
  const { stored, resolution, systemIdentity, syncing, error, selectProfile } = identity;
  const defaultProfile = stored.profiles.find((profile) => profile.id === stored.globalDefaultProfileId) ?? null;
  const systemDetail = systemIdentity ? `${systemIdentity.name} · ${systemIdentity.email}` : tr("gitidentity.systemDetail");
  const projectValue = stored.repositoryProfileIds[projectId] ?? INHERIT;
  const author = resolution.ok ? resolution.commitAuthor : null;
  const applied = resolution.ok ? resolution.profile : null;
  const rowLabel = label ?? tr("gitidentity.projectIdentity");

  return (
    <>
      <Row label={rowLabel} hint={tr("gitidentity.projectIdentityHint")} itemId="git.projectIdentity">
        <Select
          label={rowLabel}
          ariaLabel={rowLabel}
          value={projectValue}
          disabled={syncing}
          className="git-identity-picker"
          onChange={(value) => selectProfile(value === INHERIT ? null : value)}
          options={[
            { value: INHERIT, label: tr("gitidentity.useDefault"), detail: defaultProfile?.label ?? tr("gitsettings.systemGit") },
            { value: SYSTEM_SOURCE_CONTROL_PROFILE_ID, label: tr("gitsettings.systemGit"), detail: systemDetail },
            ...stored.profiles.map((profile) => ({ value: profile.id, label: profile.label, detail: authorOf(profile) })),
          ]}
        />
      </Row>
      <div className="git-identity-status" role="status" aria-live="polite">
        {!resolution.ok
          ? <span className="form-error">{tr("gitidentity.unavailable")}</span>
          : syncing ? <span>{tr("gitsettings.applyingIdentity")}</span>
          : (
            <span>
              {tr("gitidentity.commitsAs", { author: author ? `${author.name} · ${author.email}` : tr("gitsettings.notSet") })}
              {applied && identityFacts(applied).map((fact) => <Badge key={fact}>{fact}</Badge>)}
              {resolution.source === "global" && <Badge>{tr("gitidentity.fromDefault")}</Badge>}
            </span>
          )}
        {error && <span className="form-error">{error}</span>}
      </div>
    </>
  );
}

/** The instance owner's checkout identities (`POST /api/git/identity` is
 *  owner-only): the default every project inherits and the identities each
 *  project may pick. GitSettings renders this only when
 *  `mayWriteCheckoutIdentity`. */
export function RepositoryIdentities() {
  const stored = useSourceControlProfileState();
  const projectId = useStore((s) => s.activeProjectId);
  const [editing, setEditing] = useState<{ profile: SourceControlProfile; isNew: boolean } | null>(null);
  const projectProfileId = projectId ? stored.repositoryProfileIds[projectId] : undefined;
  const profileOptions = stored.profiles.map((profile) => ({ value: profile.id, label: profile.label, detail: authorOf(profile) }));

  return (
    <>
      <Section
        title={tr("gitidentity.sectionTitle")}
        hint={tr("gitidentity.sectionHint")}
        itemId="git.sourceControlProfiles"
        action={<Button size="sm" variant="quiet" onClick={() => setEditing({ profile: blankIdentity(), isNew: true })}>{tr("gitidentity.new")}</Button>}
      >
        <Row label={tr("gitidentity.defaultIdentity")} hint={tr("gitidentity.defaultIdentityHint")} itemId="git.defaultIdentity">
          <Select
            label={tr("gitidentity.defaultIdentity")}
            ariaLabel={tr("gitidentity.defaultIdentity")}
            value={stored.globalDefaultProfileId && stored.globalDefaultProfileId !== SYSTEM_SOURCE_CONTROL_PROFILE_ID ? stored.globalDefaultProfileId : ""}
            className="git-identity-picker"
            onChange={(value) => setGlobalSourceControlProfile(value || null)}
            options={[{ value: "", label: tr("gitsettings.systemGit"), detail: tr("gitidentity.systemDetail") }, ...profileOptions]}
          />
        </Row>
        <ItemList label={tr("gitidentity.sectionTitle")} className="git-identity-list">
          <ItemRow
            icon={<span className="git-identity-tile">S</span>}
            title={tr("gitsettings.systemGit")}
            description={tr("gitidentity.systemDetail")}
            meta={(
              <>
                {projectProfileId === SYSTEM_SOURCE_CONTROL_PROFILE_ID && <Badge tone="accent">{tr("gitidentity.thisProject")}</Badge>}
                {!stored.globalDefaultProfileId && <Badge>{tr("gitsettings.isDefault")}</Badge>}
              </>
            )}
          />
          {stored.profiles.map((profile) => {
            const isDefault = stored.globalDefaultProfileId === profile.id;
            const pinnedHere = projectProfileId === profile.id;
            const actionsLabel = tr("gitsettings.identityActions", { name: profile.label });
            const usedBy = Object.values(stored.repositoryProfileIds).filter((id) => id === profile.id).length;
            const entries: MenuEntry[] = [
              ...(projectId && !pinnedHere ? [{
                id: "use", label: tr("gitidentity.useForProject"), onSelect: () => setRepositorySourceControlProfile(projectId, profile.id),
              }] : []),
              isDefault
                ? { id: "clear-default", label: tr("gitsettings.clearDefault"), onSelect: () => setGlobalSourceControlProfile(null) }
                : { id: "default", label: tr("gitidentity.makeDefault"), onSelect: () => setGlobalSourceControlProfile(profile.id) },
              { id: "edit", label: tr("common.edit"), onSelect: () => setEditing({ profile, isNew: false }) },
              {
                id: "delete",
                label: tr("common.delete"),
                danger: true,
                disabled: pinnedHere,
                onSelect: () => void (async () => {
                  const confirmed = await confirmAlert(tr("gitsettings.deleteIdentityConfirm", { name: profile.label }), {
                    title: tr("common.delete"),
                    confirmLabel: tr("common.delete"),
                    destructive: true,
                  });
                  if (confirmed) removeSourceControlProfile(profile.id);
                })(),
              },
            ];
            return (
              <ItemRow
                key={profile.id}
                icon={<span className="git-identity-tile">{profile.label.slice(0, 1).toUpperCase()}</span>}
                title={profile.label}
                description={[authorOf(profile), ...identityFacts(profile), ...(usedBy ? [tr("gitidentity.usedBy", { count: usedBy })] : [])].join(" · ")}
                meta={(
                  <>
                    {pinnedHere && <Badge tone="accent">{tr("gitidentity.thisProject")}</Badge>}
                    {isDefault && <Badge>{tr("gitsettings.isDefault")}</Badge>}
                  </>
                )}
                onOpen={() => setEditing({ profile, isNew: false })}
                openLabel={tr("gitidentity.editTitle", { name: profile.label })}
                trailing={(
                  <Menu label={actionsLabel} align="end" entries={entries}>
                    {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={actionsLabel} />}
                  </Menu>
                )}
              />
            );
          })}
        </ItemList>
        {stored.profiles.length === 0 && <p className="git-identity-empty">{tr("gitidentity.empty")}</p>}
      </Section>
      {editing && (
        <SourceControlIdentityDialog
          initial={editing.profile}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={(profile) => {
            saveSourceControlProfile(profile);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

export default RepositoryIdentities;
