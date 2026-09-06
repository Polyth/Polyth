import { useEffect, useMemo, useState } from "react";
import { api, type GitBranches } from "@polyth/session/web-api";
import { setOverlay, setSidebarOpen, useStore } from "../store.ts";
import { startIsolatedSession } from "../init.ts";
import { friendlyError } from "../settings.ts";
import { tr } from "../i18n/index.ts";
import { Button, Dialog, RefreshIcon, Select, TextInput } from "./ui/index.ts";

interface RemoteBranchChoice {
  short: string;
  ref: string;
  remote: string;
}

export default function WorktreeSessionDialog() {
  const request = useStore((state) => state.worktreeSessionRequest);
  const sourceSessionId = useStore((state) => state.activeSessionId);
  const project = useStore((state) =>
    state.projectRegistry.projects.find(
      (candidate) => candidate.id === state.worktreeSessionRequest?.projectId,
    ) ?? null,
  );
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [title, setTitle] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [remoteNote, setRemoteNote] = useState("");
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
    setRemoteNote("");
    setTitle("");
    void api.gitBranches(request.projectId).then((nextBranches) => {
      if (!active) return;
      setBranches(nextBranches);
      setTargetBranch(nextBranches.current ?? nextBranches.branches.find((item) => item.current)?.name ?? "");
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(friendlyError(tr("worktreesessiondialog.couldnTLoadBranches"), cause));
      setLoading(false);
    });
    return () => { active = false; };
  }, [request?.projectId]);

  const refresh = async () => {
    if (!request || refreshing || busy) return;
    setRefreshing(true);
    setError("");
    setRemoteNote("");
    let note = "";
    try {
      await api.gitFetch(request.projectId);
    } catch {
      note = tr("gitview.remoteUnreachableShowingCached");
    }
    try {
      const nextBranches = await api.gitBranches(request.projectId);
      setBranches(nextBranches);
      setRemoteNote(note);
    } catch (cause) {
      setError(friendlyError(tr("worktreesessiondialog.couldnTLoadBranches"), cause));
    } finally {
      setRefreshing(false);
    }
  };

  const localBranches = useMemo(
    () => branches.branches.filter((item) => !item.remote),
    [branches],
  );
  const remoteBranches = useMemo<RemoteBranchChoice[]>(() => {
    const localNames = new Set(localBranches.map((item) => item.name));
    const seen = new Set<string>();
    const out: RemoteBranchChoice[] = [];
    for (const item of branches.branches) {
      if (!item.remote) continue;
      const short = item.name.slice(item.remote.length + 1);
      if (!short || short === "HEAD" || short.startsWith("HEAD ")) continue;
      if (localNames.has(short) || seen.has(short)) continue;
      seen.add(short);
      out.push({ short, ref: item.name, remote: item.remote });
    }
    return out;
  }, [branches, localBranches]);

  const submit = async () => {
    if (!request) return;
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
        ...(sourceSessionId ? { sourceSessionId } : {}),
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
            disabled={loading || !targetBranch.trim()}
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

        {loading ? <div className="empty">{tr("worktreesessiondialog.loadingBranches")}</div> : <>
          <div className="worktree-session-refresh-row">
            <Button
              size="sm"
              variant="ghost"
              iconStart={RefreshIcon}
              busy={refreshing}
              disabled={busy}
              onClick={() => void refresh()}
            >
              {refreshing ? tr("gitview.fetchingRemoteBranches") : tr("gitview.fetchRemoteBranches")}
            </Button>
          </div>
          {remoteNote && <small className="worktree-session-remote-note">{remoteNote}</small>}

          <label className="worktree-session-field">
            <span>{tr("worktreesessiondialog.baseBranch")}</span>
            <Select
              label={tr("worktreesessiondialog.baseBranch")}
              value={targetBranch}
              options={[
                ...localBranches.map((item) => ({ value: item.name, label: item.name })),
                ...remoteBranches.map((item) => ({ value: item.ref, label: item.ref })),
              ]}
              onChange={setTargetBranch}
              ariaLabel={tr("worktreesessiondialog.baseBranch")}
            />
            <small className="muted">{tr("isolation.mergeInto", { branch: targetBranch || tr("worktreesessiondialog.theCurrentCommit") })}</small>
          </label>
        </>}

        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}
