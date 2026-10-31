import { useEffect, useMemo, useState } from "react";
import { isManagedIsolationBranch } from "@polyth/contracts";
import { projectRepositories } from "@polyth/contracts/workspace";
import { api, type Worktree } from "@polyth/session/web-api";
import { setOverlay, useStore } from "../store.ts";
import { launchIsolatedSession } from "../isolatedSessionLaunch.ts";
import { friendlyError } from "../settings.ts";
import { tr } from "../i18n/index.ts";
import { Button, Dialog, RepositoryScopePicker, Select, TextInput } from "./ui/index.ts";

export default function WorktreeSessionDialog() {
  const request = useStore((state) => state.worktreeSessionRequest);
  const sourceSession = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null,
  );
  const project = useStore((state) =>
    state.projectRegistry.projects.find(
      (candidate) => candidate.id === state.worktreeSessionRequest?.projectId,
    ) ?? null,
  );
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [title, setTitle] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [repositoryMode, setRepositoryMode] = useState<"all" | "subset">("all");
  const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [branchLoading, setBranchLoading] = useState(false);
  const [error, setError] = useState("");

  const repositories = useMemo(() => {
    if (!project) return [];
    try { return [...projectRepositories(project)]; } catch { return []; }
  }, [project]);
  const primaryRepositoryId = useMemo(() =>
    project?.primaryRepositoryId
      ?? repositories.find((repository) => repository.path === project?.path)?.id
      ?? (repositories.length === 1 ? repositories[0]?.id : undefined),
  [project?.primaryRepositoryId, project?.path, repositories]);
  const scopedRepositoryIds = repositoryMode === "all"
    ? repositories.map((repository) => repository.id)
    : repositoryIds;
  const executionRepositoryId = useMemo(() => {
    if (scopedRepositoryIds.length === 0) return undefined;
    if (primaryRepositoryId && scopedRepositoryIds.includes(primaryRepositoryId)) return primaryRepositoryId;
    return scopedRepositoryIds[0];
  }, [primaryRepositoryId, scopedRepositoryIds]);
  const executionRepository = repositories.find((repository) => repository.id === executionRepositoryId) ?? null;

  const close = () => setOverlay(null);

  useEffect(() => {
    if (!request) return;
    let active = true;
    setLoading(true);
    setError("");
    setTitle("");
    const sourceRepositoryIds = sourceSession?.projectId === request.projectId
      ? sourceSession.workspace?.repositories.map((repository) => repository.repositoryId)
      : undefined;
    const sourceSubset = sourceSession?.workspace?.mode === "subset" && sourceRepositoryIds?.length;
    setRepositoryMode(sourceSubset ? "subset" : "all");
    setRepositoryIds(sourceRepositoryIds?.length
      ? sourceRepositoryIds
      : repositories.map((repository) => repository.id));
    void api.listWorktrees(request.projectId).then((next) => {
      if (!active) return;
      setWorktrees(next.filter((item) => !!item.branch && !isManagedIsolationBranch(item.branch)));
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(friendlyError(tr("worktreesessiondialog.couldnTLoadBranches"), cause));
      setLoading(false);
    });
    return () => { active = false; };
  }, [request?.projectId, request?.worktreePath, sourceSession?.id, repositories]);

  useEffect(() => {
    if (!request || !executionRepositoryId) {
      setTargetBranch("");
      return;
    }
    let active = true;
    setBranchLoading(false);
    const sourceRow = sourceSession?.projectId === request.projectId
      ? sourceSession.workspace?.repositories.find((repository) => repository.repositoryId === executionRepositoryId)
      : undefined;
    if (executionRepositoryId === primaryRepositoryId) {
      const preferred = request.worktreePath
        ? worktrees.find((item) => item.path === request.worktreePath)
        : sourceSession?.worktreePath
          ? worktrees.find((item) => item.path === sourceSession.worktreePath)
          : worktrees.find((item) => item.isMain) ?? worktrees[0];
      setTargetBranch(preferred?.branch ?? sourceRow?.branch ?? "");
      return () => { active = false; };
    }
    if (sourceRow?.branch) {
      setTargetBranch(sourceRow.branch);
      return () => { active = false; };
    }
    setBranchLoading(true);
    void api.gitBranches(request.projectId, undefined, executionRepositoryId)
      .then((branches) => {
        if (active) setTargetBranch(branches.current || "");
      })
      .catch((cause) => {
        if (active) setError(friendlyError(tr("worktreesessiondialog.couldnTLoadBranches"), cause));
      })
      .finally(() => {
        if (active) setBranchLoading(false);
      });
    return () => { active = false; };
  }, [
    request?.projectId,
    request?.worktreePath,
    executionRepositoryId,
    primaryRepositoryId,
    sourceSession?.id,
    sourceSession?.worktreePath,
    sourceSession?.workspace,
    worktrees,
  ]);

  const checkedOut = useMemo(
    () => worktrees.filter((item) => !!item.branch && !item.branch.startsWith("polyth/isolate/")),
    [worktrees],
  );

  const nested = sourceSession?.projectId === request?.projectId && !!sourceSession?.isolation;

  const submit = () => {
    if (!request || nested) return;
    const origin = targetBranch.trim();
    if (!origin) {
      setError(tr("worktreesessiondialog.enterABranchNameTo"));
      return;
    }
    // The dialog closes now; the project's spawn surface shows progress and a
    // failure comes back as the shared notice (see launchIsolatedSession).
    void launchIsolatedSession({
      projectId: request.projectId,
      ...(request.worktreePath ? { worktreePath: request.worktreePath } : {}),
      options: {
        ...(repositoryMode === "subset" ? { repositoryIds } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        targetBranch: origin,
        ...(sourceSession && sourceSession.projectId === request.projectId
          ? { sourceSessionId: sourceSession.id }
          : {}),
      },
    });
  };

  if (!request) return null;
  return (
    <Dialog
      title={tr("isolation.workInIsolation")}
      onClose={close}
      className="worktree-session-dialog"
      initialFocus="input"
      footer={(
        <>
          <span className="muted">{tr("isolation.workInIsolationHint")}</span>
          <span className="header-spacer" />
          <Button size="sm" onClick={close}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={loading || branchLoading || nested || !targetBranch.trim()
              || (repositoryMode === "subset" && repositoryIds.length === 0)}
            onClick={submit}
          >
            {tr("isolation.workInIsolation")}
          </Button>
        </>
      )}
    >
      <p className="muted worktree-session-intro">
        {tr("isolation.workInIsolationHint")}
      </p>
      <div className="worktree-session-body">
        <label className="worktree-session-field">
          <span>{tr("worktreesessiondialog.chatName")} <span className="muted">{tr("worktreesessiondialog.optional")}</span></span>
          <TextInput value={title} placeholder={tr("worktreesessiondialog.workInValue", {
            value: project?.name ?? tr("permissionbanner.thisProject"),
          })} onChange={(event) => setTitle(event.target.value)} />
        </label>

        {repositories.length > 1 && (
          <fieldset className="worktree-session-scope">
            <legend>{tr("worktreesessiondialog.repositories")}</legend>
            <label className="worktree-session-scope-option">
              <input
                type="radio"
                name="isolated-workspace-repositories"
                checked={repositoryMode === "all"}
                onChange={() => setRepositoryMode("all")}
              />
              <span>{tr("worktreesessiondialog.allRepositories")}</span>
            </label>
            <label className="worktree-session-scope-option">
              <input
                type="radio"
                name="isolated-workspace-repositories"
                checked={repositoryMode === "subset"}
                onChange={() => {
                  setRepositoryMode("subset");
                  if (repositoryIds.length === 0) setRepositoryIds(repositories.map((repository) => repository.id));
                }}
              />
              <span>{tr("worktreesessiondialog.selectRepositories")}</span>
            </label>
            {repositoryMode === "subset" && (
              <RepositoryScopePicker
                mode="subset"
                label={tr("worktreesessiondialog.selectRepositories")}
                repositories={repositories.map((repository) => ({
                  id: repository.id,
                  alias: repository.alias,
                  detail: repository.path,
                }))}
                value={repositoryIds}
                onChange={(next) => setRepositoryIds([...next])}
              />
            )}
            <small className="muted">
              {executionRepository
                ? tr("worktreesessiondialog.runtimeStartsIn", { repository: executionRepository.alias })
                : tr("worktreesessiondialog.selectAtLeastOne")}
            </small>
          </fieldset>
        )}

        {loading || branchLoading ? <div className="empty">{tr("worktreesessiondialog.loadingBranches")}</div> : (
          <label className="worktree-session-field">
            <span>{tr("worktreesessiondialog.baseBranch")}{executionRepository ? ` · ${executionRepository.alias}` : ""}</span>
            <Select
              label={tr("worktreesessiondialog.baseBranch")}
              value={targetBranch}
              options={(executionRepositoryId === primaryRepositoryId
                ? checkedOut.map((item) => ({
                    value: item.branch!,
                    label: item.branch!,
                  }))
                : targetBranch
                  ? [{ value: targetBranch, label: targetBranch }]
                  : [])}
              onChange={setTargetBranch}
              ariaLabel={tr("worktreesessiondialog.baseBranch")}
            />
            <small className="muted">{tr("isolation.mergeInto", { branch: targetBranch || tr("worktreesessiondialog.theCurrentCommit") })}</small>
          </label>
        )}

        {nested && <div className="inline-error" role="alert">{tr("isolation.nestedUnsupported")}</div>}
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}
