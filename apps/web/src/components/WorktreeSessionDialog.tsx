import { useEffect, useMemo, useState } from "react";
import { api, type GitBranches, type Worktree } from "../api.ts";
import { setOverlay, setSidebarOpen, startNewSession, useStore } from "../store.ts";
import { friendlyError } from "../settings.ts";
import { randomWorktreeSlug, suggestWorktreeBranch } from "../worktreeSessions.ts";
import Dialog from "./a11y/Dialog.tsx";
import { tr } from "../i18n/index.ts";

export default function WorktreeSessionDialog() {
  const request = useStore((state) => state.worktreeSessionRequest);
  const template = useStore((state) => state.settings.branchTemplate);
  const project = useStore((state) =>
    state.projectRegistry.projects.find(
      (candidate) => candidate.id === state.worktreeSessionRequest?.projectId,
    ) ?? null,
  );
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [branchSeed, setBranchSeed] = useState(randomWorktreeSlug);
  const [branchTouched, setBranchTouched] = useState(false);
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
    setBranchTouched(false);
    setBranchSeed(randomWorktreeSlug());
    void Promise.all([
      api.listWorktrees(request.projectId),
      api.gitBranches(request.projectId),
    ]).then(([nextWorktrees, nextBranches]) => {
      if (!active) return;
      setWorktrees(nextWorktrees);
      setBranches(nextBranches);
      setBaseBranch(nextBranches.current ?? nextBranches.branches.find((item) => item.current)?.name ?? "");
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(friendlyError(tr("worktreesessiondialog.couldnTLoadBranches"), cause));
      setLoading(false);
    });
    return () => { active = false; };
  }, [request?.projectId]);

  const linkedBranches = useMemo(
    () => new Set(worktrees.map((worktree) => worktree.branch).filter((value): value is string => !!value)),
    [worktrees],
  );
  const localBranches = useMemo(
    () => branches.branches.filter((item) => !item.remote),
    [branches],
  );
  const suggestion = useMemo(
    () => suggestWorktreeBranch(template, branchSeed, [...linkedBranches, ...localBranches.map((item) => item.name)]),
    [template, branchSeed, linkedBranches, localBranches],
  );
  useEffect(() => {
    if (!branchTouched) setBranch(suggestion);
  }, [suggestion, branchTouched]);

  const branchName = branch.trim();
  const selectedExistingBranch = localBranches.find((item) => item.name === branchName) ?? null;
  const branchAlreadyCheckedOut = !!selectedExistingBranch && linkedBranches.has(branchName);
  const createsBranch = !!branchName && !selectedExistingBranch;
  const status = !branchName
    ? tr("worktreesessiondialog.enterABranchNameTo")
    : branchAlreadyCheckedOut
      ? tr("worktreesessiondialog.thisBranchAlreadyHasA")
      : selectedExistingBranch
        ? tr("worktreesessiondialog.aNewCheckoutWillBe", { branch: branchName })
        : tr("worktreesessiondialog.aNewBranchWillBe", { base: baseBranch || tr("worktreesessiondialog.theCurrentCommit") });

  const submit = async () => {
    if (!request) return;
    if (!branchName) {
      setError(tr("worktreesessiondialog.branchNameIsRequired"));
      return;
    }
    if (branchAlreadyCheckedOut) {
      setError(tr("worktreesessiondialog.thatBranchAlreadyHasA"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      setProgress(tr("worktreesessiondialog.creatingWorktree"));
      const worktreePath = (await api.createWorktree(
        request.projectId,
        branchName,
        undefined,
        createsBranch && baseBranch ? baseBranch : undefined,
      )).path;
      setProgress(tr("worktreesessiondialog.openingChat"));
      startNewSession(request.projectId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        worktreePath,
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
    <Dialog title={tr("worktreesessiondialog.newWorktree")} onClose={close} className="worktree-session-dialog" initialFocus="input">
      <div className="dialog-head">
        <div>
          <h2>{tr("worktreesessiondialog.newWorktree")}</h2>
          <p className="muted">{tr("worktreesessiondialog.createAnIsolatedCheckoutAnd")}</p>
        </div>
        <button className="icon-btn" aria-label={tr("worktreesessiondialog.closeDialog")} disabled={busy} onClick={close}>{tr("worktreesessiondialog.message")}</button>
      </div>

      <div className="worktree-session-body">
        <label className="worktree-session-field">
          <span>{tr("worktreesessiondialog.chatName")} <span className="muted">{tr("worktreesessiondialog.optional")}</span></span>
          <input value={title} placeholder={tr("worktreesessiondialog.workInValue", {
            value: project?.name ?? tr("permissionbanner.thisProject"),
          })} onChange={(event) => setTitle(event.target.value)} />
        </label>

        {loading ? <div className="empty">{tr("worktreesessiondialog.loadingBranches")}</div> : <>
          <label className="worktree-session-field">
            <span>{tr("worktreesessiondialog.branch")}</span>
            <input
              className="mono"
              value={branch}
              placeholder={suggestion}
              list="worktree-branches"
              onChange={(event) => { setBranch(event.target.value); setBranchTouched(true); setError(""); }}
              aria-describedby="worktree-branch-status"
            />
            <datalist id="worktree-branches">
              {localBranches.filter((item) => !linkedBranches.has(item.name)).map((item) => <option key={item.name} value={item.name} />)}
            </datalist>
            <small id="worktree-branch-status" className={branchAlreadyCheckedOut ? "worktree-field-warning" : "muted"}>{status}</small>
          </label>

          {createsBranch && <label className="worktree-session-field">
            <span>{tr("worktreesessiondialog.baseBranch")}</span>
            <select value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
              {localBranches.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            <small className="muted">{tr("worktreesessiondialog.theNewBranchStartsFrom")}</small>
          </label>}

          <p className="worktree-checkout-note">{tr("worktreesessiondialog.theCheckoutFolderIsCreatedAutomatically")}</p>
        </>}

        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>

      <div className="dialog-foot">
        <span className="muted">{progress || tr("worktreesessiondialog.aNewChatOpensAs")}</span>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy} onClick={close}>{tr("common.cancel")}</button>
        <button className="primary-btn" disabled={busy || loading || !branchName || branchAlreadyCheckedOut} onClick={() => void submit()}>
          {busy ? progress || tr("worktreesessiondialog.creating") : tr("worktreesessiondialog.createWorktreeStartChat")}
        </button>
      </div>
    </Dialog>
  );
}
