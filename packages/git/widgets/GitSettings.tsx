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
import { Button, Textarea, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import SourceControlProfilesSettings from "./SourceControlProfilesSettings.tsx";

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
      <PageHead title="Source Control" blurb="Repository identity, Git behavior, and conflict recovery for the active project." />
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
          <SourceControlProfilesSettings projectId={projectId} />
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
