// Project settings → Git identity: which identity commits in this project.
// The instance owner picks one of the Space's identities (or the default);
// everyone else commits with their own Profile → Git identity (Spaces §14.4).
import { useState } from "react";
import type { Project } from "@polyth/contracts";
import type { WebPackageHost } from "@polyth/web-sdk";
import { BackIcon, Button } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ProjectIdentityRows } from "./SourceControlProfilesSettings.tsx";
import SourceControlIdentityDialog, { blankIdentity } from "./SourceControlIdentityDialog.tsx";
import { saveSourceControlProfile, setRepositorySourceControlProfile } from "./sourceControlProfiles.ts";
import { useSourceControlIdentity } from "./useSourceControlIdentity.ts";
import { mayWriteCheckoutIdentity, usePersonGitProfile } from "./personGitProfile.ts";
import { PERSON_PROFILE_ITEM } from "./gitRefusal.ts";

function OwnerIdentity({ host, project }: { host: WebPackageHost; project: Project }) {
  const identity = useSourceControlIdentity(project.id);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="git-project-identity-rows">
        <ProjectIdentityRows projectId={project.id} identity={identity} />
      </div>
      <div className="git-project-identity-actions">
        <Button size="sm" onClick={() => setCreating(true)}>{tr("gitidentity.newForProject")}</Button>
        <Button size="sm" variant="ghost" onClick={() => host.navigation.openSettingsPage("git", { itemId: "git.sourceControlProfiles" })}>
          {tr("gitidentity.manage")}
        </Button>
      </div>
      {creating && (
        <SourceControlIdentityDialog
          initial={blankIdentity()}
          isNew
          onClose={() => setCreating(false)}
          onSave={(profile) => {
            saveSourceControlProfile(profile);
            setRepositorySourceControlProfile(project.id, profile.id);
            setCreating(false);
          }}
        />
      )}
    </>
  );
}

export default function ProjectGitIdentity({ host, project, onBack }: { host: WebPackageHost; project: Project; onBack(): void }) {
  const person = usePersonGitProfile();
  const owner = person.status !== "loading" && mayWriteCheckoutIdentity(person);
  const profile = person.status === "ready" ? person.dto.profile : null;
  return (
    <div className="git-project-identity">
      <div className="git-project-identity-intro">
        <Button size="sm" variant="ghost" iconStart={BackIcon} onClick={onBack}>{tr("common.back")}</Button>
      </div>
      <p className="git-project-identity-hint">
        {owner ? tr("gitidentity.projectPageHint", { project: project.name }) : tr("gitidentity.memberPageHint")}
      </p>
      {person.status === "loading"
        ? <p className="git-project-identity-hint" role="status">{tr("common.loading")}</p>
        : owner
          ? <OwnerIdentity host={host} project={project} />
          : (
            <div className="git-project-identity-member">
              <span>{profile ? `${profile.name} · ${profile.email}` : tr("gitidentity.memberNoProfile")}</span>
              <Button size="sm" onClick={() => host.navigation.openSettingsPage("git", { itemId: PERSON_PROFILE_ITEM })}>
                {profile ? tr("gitidentity.memberChange") : tr("gitidentity.memberSet")}
              </Button>
            </div>
          )}
    </div>
  );
}
