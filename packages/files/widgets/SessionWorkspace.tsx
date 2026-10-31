import { useState } from "react";
import { projectRepositories, resolveWorkspaceContext } from "@polyth/contracts/workspace";
import { api } from "@polyth/session/web-api";
import { Button, Checkbox, RepositoriesIcon, ResponsiveOverlay, WarningIcon } from "../../../apps/web/src/components/ui/index.ts";
import { getState, openSettingsPage, upsertSession, useStore, workspaceProjectId } from "../../../apps/web/src/store.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import "./session-workspace.css";

/** An open session's repository membership, shown in the session header.
 * A new chat chooses its repositories in the composer's location row. */
export default function SessionWorkspace({ openRepositories }: { placement?: "header"; openRepositories?: (projectId: string) => void }) {
  const projectId = useStore(workspaceProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  if (!projectId || sessionId === null) return null;
  return <WorkspaceControl key={`${projectId}:${sessionId}`} projectId={projectId} sessionId={sessionId} openRepositories={openRepositories} />;
}

function WorkspaceControl({ projectId, sessionId, openRepositories }: { projectId: string; sessionId: string; openRepositories?: (projectId: string) => void }) {
  const project = useStore((state) => state.projectRegistry.projects.find((row) => row.id === projectId));
  const session = useStore((state) => state.sessions.find((row) => row.id === sessionId));
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!project || !session) return null;
  let repositories;
  let workspace;
  try {
    repositories = projectRepositories(project);
    workspace = resolveWorkspaceContext(project, session);
  } catch { return null; }
  const included = workspace.repositories.map((row) => row.repositoryId);
  const isolated = !!session.isolation
    || !!session.workspace?.repositories.some((row) => row.isolation)
    || !!(!session.workspace && session.worktreePath);
  const isolatedChat = isolated
    || !!session.workspace?.repositories.some((row) => row.branch?.startsWith("polyth/isolate/"))
    || session.branch?.startsWith("polyth/isolate/") === true;
  if (isolatedChat) return null;
  const registeredById = new Map(repositories.map((row) => [row.id, row]));
  const relocateRepositoryIds = workspace.repositories
    .filter((row) => registeredById.get(row.repositoryId)?.path !== undefined
      && registeredById.get(row.repositoryId)?.path !== row.path)
    .map((row) => row.repositoryId);
  const aliases = repositories.filter((row) => included.includes(row.id)).map((row) => row.alias);
  const missing = workspace.repositories.some((row) => row.state === "missing");
  const missingAliases = workspace.repositories.filter((row) => row.state === "missing").map((row) => row.alias ?? row.repositoryId);
  const readyIds = workspace.repositories
    .filter((row) => row.state === "ready" && registeredById.has(row.repositoryId))
    .map((row) => row.repositoryId);
  if (repositories.length < 2 && !missing && relocateRepositoryIds.length === 0) return null;
  const label = `${aliases.slice(0, 2).join(" + ")}${aliases.length > 2 ? ` +${aliases.length - 2}` : ""}`;
  const show = () => {
    setSelected(included);
    setAll(session.workspace ? session.workspace.mode === "all" : !session.isolation);
    setRevision(session.workspace?.revision ?? 0);
    setError("");
    setOpen(true);
  };
  const saveWorkspace = async (nextAll: boolean, nextSelected: string[], relocateIds: readonly string[] = []) => {
    setBusy(true);
    setError("");
    try {
      const updated = await api.updateSessionWorkspace(sessionId, {
        ...(!nextAll ? { repositoryIds: nextSelected } : {}),
        ...(relocateIds.length > 0 ? { relocateRepositoryIds: relocateIds } : {}),
        expectedRevision: revision,
      });
      if (getState().activeProjectId !== projectId || getState().activeSessionId !== sessionId) return;
      upsertSession(updated);
      setOpen(false);
    } catch (cause) { setError(friendlyError(tr("filesreg.swErrUpdate"), cause)); }
    finally { setBusy(false); }
  };
  const save = async () => saveWorkspace(all, selected);
  const continueWithoutMissing = async () => {
    if (!missing) return;
    await saveWorkspace(false, readyIds);
  };
  const useLocatedRepositories = async () => {
    if (relocateRepositoryIds.length === 0) return;
    await saveWorkspace(false, included, relocateRepositoryIds);
  };
  const footer = <>
    <Button disabled={busy} onClick={() => setOpen(false)}>{tr("filesreg.cancel")}</Button>
    <Button variant="primary" busy={busy} disabled={busy || (!all && selected.length === 0)} onClick={() => void save()}>{tr("filesreg.swUpdateWorkspace")}</Button>
  </>;
  return <>
    <Button size="sm" variant="ghost" className="files-workspace-indicator" data-attention={missing || relocateRepositoryIds.length > 0 ? "true" : undefined}
      title={missing ? tr("filesreg.swTitleMissing", { aliases: missingAliases.join(" + ") }) : tr("filesreg.swTitleOk", { aliases: aliases.join(", ") })}
      aria-label={tr(missing ? "filesreg.swAriaMissing" : "filesreg.swAria", { aliases: aliases.join(", ") })}
      iconStart={missing ? WarningIcon : RepositoriesIcon} onClick={show}>
      <span className="files-workspace-label">{label}</span>
    </Button>
    <ResponsiveOverlay open={open} onClose={() => { if (!busy) setOpen(false); }} title={tr("filesreg.swDialogTitle")} desktop="dialog" phone="sheet" dialogSize="sm" className="files-session-workspace" dialogFooter={footer} sheetFooter={footer}>
      <p className="files-workspace-intro">{tr("filesreg.swIntro")}</p>
      <fieldset className="files-workspace-mode" disabled={busy}>
        <legend>{tr("filesreg.reposLabel")}</legend>
        <label><input type="radio" name="workspace-membership" checked={all} onChange={() => setAll(true)} /> {tr("filesreg.swAllRepos")}</label>
        <label><input type="radio" name="workspace-membership" checked={!all} onChange={() => setAll(false)} /> {tr("filesreg.swSelectRepos")}</label>
      </fieldset>
      {missing && (
        <div className="files-workspace-missing" role="alert">
          <strong>{tr("filesreg.swUnavailableNamed", { aliases: missingAliases.join(" + ") })}</strong>
          <span>{tr("filesreg.swCanContinue")}</span>
          <Button size="sm" variant="ghost" disabled={busy || readyIds.length === 0} onClick={() => void continueWithoutMissing()}>{tr("filesreg.swContinueWithout")}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
            setOpen(false);
            if (openRepositories) openRepositories(projectId); else openSettingsPage("projects");
          }}>{tr("filesreg.swLocateRepos")}</Button>
          <span className="files-workspace-note">{tr("filesreg.swLocateNote")}</span>
        </div>
      )}
      {relocateRepositoryIds.length > 0 && (
        <div className="files-workspace-relocate" role="status">
          <strong>{tr("filesreg.swRegChanged")}</strong>
          <span>{tr("filesreg.swRegChangedBody")}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void useLocatedRepositories()}>{tr("filesreg.swUseLocated")}</Button>
        </div>
      )}
      <div className="files-workspace-members">
        {repositories.map((repository) => {
          const checkout = workspace.repositories.find((row) => row.repositoryId === repository.id);
          return <Checkbox key={repository.id} checked={all || selected.includes(repository.id)} disabled={busy || all}
            label={repository.alias}
            description={checkout?.state === "missing" ? tr("filesreg.swMemberUnavailable") : checkout?.branch ?? (included.includes(repository.id) ? repository.path : tr("filesreg.swNotIncluded"))}
            onChange={(checked) => setSelected((current) => checked ? [...current, repository.id] : current.filter((id) => id !== repository.id))} />;
        })}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </ResponsiveOverlay>
  </>;
}
