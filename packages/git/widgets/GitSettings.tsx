import { useEffect, useState } from "react";
import { api, type GitStatus } from "@polyth/session/web-api";
import {
  openWorkspacePane,
  setOverlay,
  updateSettings,
  useStore,
} from "../../../apps/web/src/store.ts";
import { EmptyState, PageHead, Row, Seg } from "../../../apps/web/src/components/settings/parts.tsx";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, Dialog, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import {
  removeGitPersona,
  saveGitPersona,
  useGitPersonas,
  type GitPersona,
} from "./gitPersonas.ts";

function GitPersonas({ projectId }: { projectId: string }) {
  const personas = useGitPersonas();
  const [identity, setIdentity] = useState({ name: "", email: "" });
  const [draft, setDraft] = useState<GitPersona | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api.gitIdentity(projectId).then(setIdentity).catch(() => setIdentity({ name: "", email: "" }));
  }, [projectId]);
  const apply = async (persona: GitPersona) => {
    try {
      setError("");
      setIdentity(await api.gitIdentitySet(projectId, persona));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <section className="git-personas" data-settings-item="git.personas">
      <div className="settings-section-head">
        <div><strong>{tr("settings.pages.gitPersonas")}</strong><span>{tr("settings.pages.savedIdentitiesYouCanApplyToThis")}</span></div>
        <Button size="sm" onClick={() => setDraft({ id: crypto.randomUUID(), label: "", name: "", email: "" })}>{tr("settings.pages.persona")}</Button>
      </div>
      <div className="git-current-identity">
        {tr("settings.pages.currentRepositoryIdentity")}{" "}<strong>{identity.name || tr("settings.pages.notSet")}</strong>
        <span className="mono">{identity.email || "—"}</span>
      </div>
      {personas.map((persona) => {
        const active = persona.name === identity.name && persona.email === identity.email;
        return (
          <div key={persona.id} className={`git-persona-row${active ? " active" : ""}`}>
            <span className="profile-avatar">{persona.label.slice(0, 1).toUpperCase()}</span>
            <span><strong>{persona.label}</strong><small>{persona.name} · {persona.email}</small></span>
            {active && <span className="tag">{tr("settings.pages.inUse")}</span>}
            <Button size="sm" disabled={active} onClick={() => void apply(persona)}>{tr("settings.pages.use")}</Button>
            <Button size="sm" onClick={() => setDraft(persona)}>{tr("common.edit")}</Button>
            <Button size="sm" variant="danger" onClick={() => removeGitPersona(persona.id)}>{tr("common.delete")}</Button>
          </div>
        );
      })}
      {personas.length === 0 && (
        <EmptyState
          title={tr("settings.pages.gitPersonas")}
          body={tr("settings.pages.addAWorkPersonalOrBotIdentity")}
        />
      )}
      {error && <div className="form-error">{error}</div>}
      {draft && (
        <Dialog
          title={draft.label ? tr("settings.pages.editValue", { label: draft.label }) : tr("settings.pages.newGitPersona")}
          onClose={() => setDraft(null)}
          className="profile-form"
          initialFocus=".git-persona-label"
          footer={(
            <>
              <Button size="sm" onClick={() => setDraft(null)}>{tr("common.cancel")}</Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.label.trim() || !draft.name.trim() || !draft.email.trim()}
                onClick={() => { saveGitPersona({ ...draft, label: draft.label.trim(), name: draft.name.trim(), email: draft.email.trim() }); setDraft(null); }}
              >
                {tr("settings.pages.savePersona")}
              </Button>
            </>
          )}
        >
          <div className="profile-form-body">
            <label>{tr("settings.pages.label")}<TextInput className="git-persona-label" value={draft.label} placeholder={tr("settings.pages.work")} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
            <label>{tr("settings.pages.commitAuthorName")}<TextInput value={draft.name} placeholder={tr("settings.pages.adaLovelace")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>{tr("settings.pages.commitEmail")}<TextInput type="email" value={draft.email} placeholder={tr("settings.pages.adaExampleCom")} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
          </div>
        </Dialog>
      )}
    </section>
  );
}

export default function GitSettings() {
  const projectId = useStore((s) => s.activeProjectId);
  const settings = useStore((s) => s.settings);
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!projectId) { setStatus(null); return; }
    void api.gitStatus(projectId).then(setStatus);
  }, [projectId]);
  if (!projectId) return <><PageHead title={tr("settings.pages.git")} /><EmptyState title={tr("settings.pages.noActiveProject")} /></>;
  const changes = status ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length : 0;
  return (
    <>
      <PageHead title={tr("settings.pages.git")} blurb={tr("settings.pages.repositoryStateForTheActiveProject")} />
      {!status?.branch ? (
        <EmptyState title={tr("settings.pages.notAGitRepository")} body={tr("settings.pages.initializeARepoToUseTheGit")} />
      ) : (
        <>
          <Row label={tr("settings.pages.branch")}><span className="mono">{status.branch}</span></Row>
          <Row label={tr("settings.pages.workingTree")}><span className="mono">{changes === 0
            ? tr("settings.pages.clean")
            : changes === 1
              ? tr("settings.pages.oneChangedFile")
              : tr("settings.pages.valueChangedFiles", { count: changes })}</span></Row>
          <Row label={tr("settings.pages.aheadBehind")}><span className="mono">↑{status.ahead} ↓{status.behind}</span></Row>
          <GitPersonas projectId={projectId} />
          <Row label={tr("settings.pages.branchNameTemplate")} hint={tr("settings.pages.tokensValueAndValueStoredLocally")} itemId="git.branchTemplate">
            <TextInput
              uiSize="sm"
              className="inp-mono"
              value={settings.branchTemplate}
              onChange={(e) => updateSettings({ branchTemplate: e.target.value })}
            />
          </Row>
          <Row
            label={tr("settings.pages.conflictAgentPrompt")}
            hint={tr("settings.pages.conflictAgentPromptHint")}
            itemId="git.conflictAgentPrompt"
          >
            <Textarea
              className="git-conflict-agent-prompt"
              rows={4}
              value={settings.conflictAgentPrompt}
              onChange={(event) => updateSettings({ conflictAgentPrompt: event.target.value })}
            />
          </Row>
          <Row
            label={tr("settings.pages.conflictAgentTarget")}
            hint={tr("settings.pages.conflictAgentTargetHint")}
            itemId="git.conflictAgentTarget"
          >
            <Seg
              value={settings.conflictAgentTarget}
              options={[
                ["new-session", tr("settings.pages.newSession")],
                ["current-session", tr("settings.pages.currentSession")],
              ]}
              onChange={(conflictAgentTarget) => updateSettings({ conflictAgentTarget })}
            />
          </Row>
          <Row label={tr("settings.pages.fullView")} hint={tr("settings.pages.stageCommitBranchAndManageWorktrees")}>
            <Button size="sm" onClick={() => { setOverlay(null); openWorkspacePane("git"); }}>{tr("settings.pages.openGitView")}</Button>
          </Row>
        </>
      )}
    </>
  );
}
