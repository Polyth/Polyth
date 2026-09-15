import { useState } from "react";
import {
  SYSTEM_SOURCE_CONTROL_PROFILE_ID,
  type SourceControlAuthMode,
  type SourceControlProfile,
  type SourceControlProvider,
} from "@polyth/contracts/source-control";
import { Button, Dialog, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState } from "../../../apps/web/src/components/settings/parts.tsx";
import {
  removeSourceControlProfile,
  saveSourceControlProfile,
  setGlobalSourceControlProfile,
} from "./sourceControlProfiles.ts";
import { useSourceControlIdentity } from "./useSourceControlIdentity.ts";

const blankProfile = (): SourceControlProfile => ({
  id: crypto.randomUUID(),
  label: "",
  provider: "generic",
  commitAuthor: { name: "", email: "" },
  authentication: { mode: "system-git" },
});

const providerName = (provider: SourceControlProvider): string => {
  if (provider === "github") return "GitHub";
  if (provider === "gitlab") return "GitLab";
  return "Generic Git";
};

const authName = (mode: SourceControlAuthMode): string => {
  if (mode === "provider-cli") return "Provider CLI";
  if (mode === "ssh-agent") return "SSH agent";
  if (mode === "credential-helper") return "Credential helper";
  if (mode === "managed") return "Managed provider account";
  return "System Git";
};

export default function SourceControlProfilesSettings({ projectId }: { projectId: string }) {
  const {
    stored,
    currentIdentity,
    resolution,
    syncing,
    error,
    selectProfile,
  } = useSourceControlIdentity(projectId);
  const [draft, setDraft] = useState<SourceControlProfile | null>(null);

  const activeId = resolution.ok
    ? resolution.profile?.id ?? SYSTEM_SOURCE_CONTROL_PROFILE_ID
    : stored.repositoryProfileIds[projectId];

  return (
    <section className="git-personas source-control-profiles" data-settings-item="git.sourceControlProfiles">
      <div className="settings-section-head">
        <div>
          <strong>Source Control Profiles</strong>
          <span>One repository identity for commit authorship, hosting account, and authentication source.</span>
        </div>
        <Button size="sm" onClick={() => setDraft(blankProfile())}>+ Profile</Button>
      </div>

      <div className="git-current-identity">
        Current repository
        <strong>{resolution.ok ? resolution.profile?.label ?? "System Git" : "Profile unavailable"}</strong>
        <span className="mono">{currentIdentity?.name || "Not set"} · {currentIdentity?.email || "—"}</span>
      </div>

      <div className={`git-persona-row${activeId === SYSTEM_SOURCE_CONTROL_PROFILE_ID ? " active" : ""}`}>
        <span className="profile-avatar">S</span>
        <span><strong>System Git</strong><small>Existing SSH agent, credential helper, provider CLI and Git configuration</small></span>
        {activeId === SYSTEM_SOURCE_CONTROL_PROFILE_ID && <span className="tag">In use</span>}
        <Button size="sm" disabled={syncing || activeId === SYSTEM_SOURCE_CONTROL_PROFILE_ID} onClick={() => selectProfile(SYSTEM_SOURCE_CONTROL_PROFILE_ID)}>Use</Button>
      </div>

      {stored.profiles.map((profile) => {
        const active = activeId === profile.id;
        const isDefault = stored.globalDefaultProfileId === profile.id;
        const detail = [
          providerName(profile.provider),
          profile.host,
          profile.username ? `@${profile.username}` : profile.account,
          authName(profile.authentication.mode),
        ].filter(Boolean).join(" · ");
        return (
          <div key={profile.id} className={`git-persona-row${active ? " active" : ""}`}>
            <span className="profile-avatar">{profile.label.slice(0, 1).toUpperCase()}</span>
            <span>
              <strong>{profile.label}</strong>
              <small>{detail}</small>
              {profile.commitAuthor && <small>{profile.commitAuthor.name} · {profile.commitAuthor.email}</small>}
            </span>
            {active && <span className="tag">In use</span>}
            {isDefault && <span className="tag">Default</span>}
            <Button size="sm" disabled={syncing || active} onClick={() => selectProfile(profile.id)}>Use</Button>
            <Button size="sm" disabled={isDefault} onClick={() => setGlobalSourceControlProfile(profile.id)}>Default</Button>
            <Button size="sm" onClick={() => setDraft(profile)}>Edit</Button>
            <Button size="sm" variant="danger" disabled={active} onClick={() => removeSourceControlProfile(profile.id)}>Delete</Button>
          </div>
        );
      })}

      {stored.profiles.length === 0 && (
        <EmptyState
          title="No managed source control profiles"
          body="System Git remains available. Add a profile only when a repository needs an explicit work, personal, bot, or provider identity."
        />
      )}

      {stored.globalDefaultProfileId && (
        <div className="source-control-default-actions">
          <Button size="sm" variant="ghost" onClick={() => setGlobalSourceControlProfile(null)}>Clear global default</Button>
        </div>
      )}
      {syncing && <div role="status" className="muted">Applying repository identity…</div>}
      {error && <div className="form-error">{error}</div>}

      {draft && (
        <Dialog
          title={draft.label ? `Edit ${draft.label}` : "New source control profile"}
          onClose={() => setDraft(null)}
          className="profile-form"
          initialFocus=".source-profile-label"
          footer={(
            <>
              <Button size="sm" onClick={() => setDraft(null)}>Cancel</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.label.trim() || !draft.commitAuthor?.name.trim() || !draft.commitAuthor.email.trim()}
                onClick={() => {
                  const host = draft.host?.trim();
                  const account = draft.account?.trim();
                  const username = draft.username?.trim();
                  saveSourceControlProfile({
                    ...draft,
                    label: draft.label.trim(),
                    ...(host ? { host } : { host: undefined }),
                    ...(account ? { account } : { account: undefined }),
                    ...(username ? { username } : { username: undefined }),
                    commitAuthor: {
                      name: draft.commitAuthor!.name.trim(),
                      email: draft.commitAuthor!.email.trim(),
                    },
                  });
                  setDraft(null);
                }}
              >Save profile</Button>
            </>
          )}
        >
          <div className="profile-form-body source-control-profile-form">
            <label>Label<TextInput className="source-profile-label" value={draft.label} placeholder="Work" onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
            <label>Provider<select value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value as SourceControlProvider })}>
              <option value="generic">Generic Git</option>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select></label>
            <label>Host <em>optional</em><TextInput value={draft.host ?? ""} placeholder={draft.provider === "gitlab" ? "gitlab.company.com" : draft.provider === "github" ? "github.com" : "git.example.com"} onChange={(event) => setDraft({ ...draft, host: event.target.value })} /></label>
            <label>Provider username <em>optional</em><TextInput value={draft.username ?? ""} placeholder="username" onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label>
            <label>Account label <em>optional</em><TextInput value={draft.account ?? ""} placeholder="Work" onChange={(event) => setDraft({ ...draft, account: event.target.value })} /></label>
            <label>Commit author name<TextInput value={draft.commitAuthor?.name ?? ""} placeholder="Ada Lovelace" onChange={(event) => setDraft({ ...draft, commitAuthor: { name: event.target.value, email: draft.commitAuthor?.email ?? "" } })} /></label>
            <label>Commit email<TextInput type="email" value={draft.commitAuthor?.email ?? ""} placeholder="ada@example.com" onChange={(event) => setDraft({ ...draft, commitAuthor: { name: draft.commitAuthor?.name ?? "", email: event.target.value } })} /></label>
            <label>Authentication<select value={draft.authentication.mode} onChange={(event) => setDraft({ ...draft, authentication: { ...draft.authentication, mode: event.target.value as SourceControlAuthMode } })}>
              <option value="system-git">System Git</option>
              <option value="ssh-agent">SSH agent</option>
              <option value="credential-helper">Credential helper</option>
              <option value="provider-cli">Provider CLI</option>
              {draft.authentication.mode === "managed" && <option value="managed" disabled>Managed provider account</option>}
            </select></label>
            <small className="muted">Provider-managed credentials are attached by provider integrations, not entered here. Profiles never store raw secrets.</small>
          </div>
        </Dialog>
      )}
    </section>
  );
}
