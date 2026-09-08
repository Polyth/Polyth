import { useEffect, useMemo, useState } from "react";
import { isManagedIsolationBranch } from "@polyth/contracts";
import { api, type Worktree } from "@polyth/session/web-api";
import { setOverlay, setSidebarOpen, useStore } from "../store.ts";
import { startIsolatedSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { tr } from "../i18n/index.ts";
import { Button, Dialog, Select, TextInput } from "./ui/index.ts";

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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const close = () => {
    if (!busy) setOverlay(null);
  };

  useEffect(() => {
    if (!request) return;
    let active = true;
    setLoading(true);
    setError("");
    setTitle("");
    void api.listWorktrees(request.projectId).then((next) => {
      if (!active) return;
      const origins = next.filter((item) => !!item.branch && !isManagedIsolationBranch(item.branch));
      setWorktrees(origins);
      const preferred = request.worktreePath
        ? origins.find((item) => item.path === request.worktreePath)
        : origins.find((item) => item.isMain) ?? origins[0];
      setTargetBranch(preferred?.branch ?? "");
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(friendlyError(tr("worktreesessiondialog.couldnTLoadBranches"), cause));
      setLoading(false);
    });
    return () => { active = false; };
  }, [request?.projectId, request?.worktreePath]);

  const checkedOut = useMemo(
    () => worktrees.filter((item) => !!item.branch),
    [worktrees],
  );

  const nested = sourceSession?.projectId === request?.projectId && !!sourceSession?.isolation;

  const submit = async () => {
    if (!request || nested) return;
    const origin = targetBranch.trim();
    if (!origin) {
      setError(tr("worktreesessiondialog.enterABranchNameTo"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      setProgress(tr("worktreesessiondialog.creatingWorktree"));
      await startIsolatedSession(request.projectId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        targetBranch: origin,
        ...(sourceSession && sourceSession.projectId === request.projectId
          ? { sourceSessionId: sourceSession.id }
          : {}),
      });
      setSidebarOpen(false);
      setOverlay(null);
    } catch (cause) {
      setError(friendlyError(tr("worktreesessiondialog.couldnTCreateTheWorktreeChat"), cause));
      setProgress("");
      setBusy(false);
    }
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
          <span className="muted">{progress || tr("isolation.workInIsolationHint")}</span>
          <span className="header-spacer" />
          <Button size="sm" disabled={busy} onClick={close}>{tr("common.cancel")}</Button>
          <Button
            size="sm"
            variant="primary"
            busy={busy}
            disabled={loading || nested || !targetBranch.trim()}
            onClick={() => void submit()}
          >
            {busy ? progress || tr("worktreesessiondialog.creating") : tr("isolation.workInIsolation")}
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

        {loading ? <div className="empty">{tr("worktreesessiondialog.loadingBranches")}</div> : (
          <label className="worktree-session-field">
            <span>{tr("worktreesessiondialog.baseBranch")}</span>
            <Select
              label={tr("worktreesessiondialog.baseBranch")}
              value={targetBranch}
              options={checkedOut.map((item) => ({
                value: item.branch!,
                label: item.isMain ? item.branch! : item.branch!,
              }))}
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
