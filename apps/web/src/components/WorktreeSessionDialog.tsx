import { useEffect, useMemo, useState } from "react";
import { api, type GitBranches, type Worktree } from "../api.ts";
import { setOverlay, setSidebarOpen, startNewSession, useStore } from "../store.ts";
import { friendlyError } from "../settings.ts";
import { randomWorktreeSlug, suggestWorktreeBranch } from "../worktreeSessions.ts";
import Dialog from "./a11y/Dialog.tsx";

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
      setError(friendlyError("Couldn’t load branches", cause));
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
    ? "Enter a branch name to continue."
    : branchAlreadyCheckedOut
      ? "This branch already has a linked worktree. Choose another branch or name."
      : selectedExistingBranch
        ? `A new checkout will be created for the existing branch ${branchName}.`
        : `A new branch will be created from ${baseBranch || "the current commit"}.`;

  const submit = async () => {
    if (!request) return;
    if (!branchName) {
      setError("Branch name is required.");
      return;
    }
    if (branchAlreadyCheckedOut) {
      setError("That branch already has a linked worktree.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setProgress("Creating worktree…");
      const worktreePath = (await api.createWorktree(
        request.projectId,
        branchName,
        undefined,
        createsBranch && baseBranch ? baseBranch : undefined,
      )).path;
      setProgress("Opening chat…");
      startNewSession(request.projectId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        worktreePath,
      });
      setSidebarOpen(false);
      setOverlay(null);
    } catch (cause) {
      setError(friendlyError("Couldn’t create the worktree chat", cause));
      setProgress("");
      setBusy(false);
    }
  };

  if (!request) return null;
  return (
    <Dialog title="New worktree" onClose={close} className="worktree-session-dialog" initialFocus="input">
      <div className="dialog-head">
        <div>
          <h2>New worktree</h2>
          <p className="muted">Create an isolated checkout and start a chat there.</p>
        </div>
        <button className="icon-btn" aria-label="Close dialog" disabled={busy} onClick={close}>×</button>
      </div>

      <div className="worktree-session-body">
        <label className="worktree-session-field">
          <span>Chat name <span className="muted">(optional)</span></span>
          <input value={title} placeholder={`Work in ${project?.name ?? "this project"}`} onChange={(event) => setTitle(event.target.value)} />
        </label>

        {loading ? <div className="empty">Loading branches…</div> : <>
          <label className="worktree-session-field">
            <span>Branch</span>
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
            <span>Base branch</span>
            <select value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
              {localBranches.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            <small className="muted">The new branch starts from this branch.</small>
          </label>}

          <p className="worktree-checkout-note">The checkout folder is created automatically.</p>
        </>}

        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>

      <div className="dialog-foot">
        <span className="muted">{progress || "A new chat opens as soon as the worktree is ready."}</span>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary-btn" disabled={busy || loading || !branchName || branchAlreadyCheckedOut} onClick={() => void submit()}>
          {busy ? progress || "Creating…" : "Create worktree & start chat"}
        </button>
      </div>
    </Dialog>
  );
}
