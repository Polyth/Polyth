import { useEffect, useMemo, useState } from "react";
import { api, type GitBranches, type Worktree } from "../api.ts";
import { setOverlay, setSidebarOpen, startNewSession, useStore } from "../store.ts";
import { friendlyError } from "../settings.ts";
import { suggestWorktreeBranch, worktreeLabel } from "../worktreeSessions.ts";
import Dialog from "./a11y/Dialog.tsx";

type Mode = "existing" | "new";

export default function WorktreeSessionDialog() {
  const request = useStore((state) => state.worktreeSessionRequest);
  const template = useStore((state) => state.settings.branchTemplate);
  const project = useStore((state) =>
    state.projectRegistry.projects.find(
      (candidate) => candidate.id === state.worktreeSessionRequest?.projectId,
    ) ?? null
  );
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [mode, setMode] = useState<Mode>("new");
  const [selectedPath, setSelectedPath] = useState("");
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState("");
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
    setQuery("");
    setTitle("");
    setBranchTouched(false);
    void Promise.all([
      api.listWorktrees(request.projectId),
      api.gitBranches(request.projectId),
    ]).then(([nextWorktrees, nextBranches]) => {
      if (!active) return;
      const linked = nextWorktrees.filter((worktree) => !worktree.isMain);
      const preselected = linked.find((worktree) => worktree.path === request.worktreePath);
      setWorktrees(nextWorktrees);
      setBranches(nextBranches);
      setSelectedPath(preselected?.path ?? linked[0]?.path ?? "");
      setMode(preselected || linked.length > 0 ? "existing" : "new");
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      setError(friendlyError("Couldn’t load worktrees", cause));
      setLoading(false);
    });
    return () => { active = false; };
  }, [request?.projectId, request?.worktreePath]);

  const linkedWorktrees = useMemo(
    () => worktrees.filter((worktree) => !worktree.isMain),
    [worktrees],
  );
  const takenBranches = useMemo(
    () => [
      ...worktrees.map((worktree) => worktree.branch).filter((value): value is string => !!value),
      ...branches.branches.map((item) => item.name),
    ],
    [worktrees, branches],
  );
  const suggestion = useMemo(
    () => suggestWorktreeBranch(template, title || "session", takenBranches),
    [template, title, takenBranches],
  );
  useEffect(() => {
    if (!branchTouched) setBranch(suggestion);
  }, [suggestion, branchTouched]);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return linkedWorktrees;
    return linkedWorktrees.filter((worktree) => {
      const haystack = `${worktree.branch ?? ""} ${worktree.path}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [linkedWorktrees, query]);

  const submit = async () => {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      let worktreePath = selectedPath;
      if (mode === "new") {
        if (!branch.trim()) throw new Error("Branch name is required.");
        setProgress("Creating worktree…");
        worktreePath = (await api.createWorktree(request.projectId, branch.trim())).path;
      }
      if (!worktreePath) throw new Error("Choose a worktree.");
      setProgress("Preparing new chat…");
      startNewSession(request.projectId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        worktreePath,
      });
      setProgress("");
      setSidebarOpen(false);
      setOverlay(null);
    } catch (cause) {
      setError(friendlyError("Couldn’t prepare the worktree chat", cause));
      setProgress("");
      setBusy(false);
    }
  };

  if (!request) return null;
  return (
    <Dialog title="New session in worktree" onClose={close} className="worktree-session-dialog" initialFocus="input">
      <div className="dialog-head">
        <div>
          <h2>New session in worktree</h2>
          <p className="muted">Run the session, terminal, preview, and Git tools in an isolated checkout.</p>
        </div>
        <button className="icon-btn" aria-label="Close dialog" disabled={busy} onClick={close}>×</button>
      </div>

      <div className="worktree-session-body">
        <label className="worktree-session-field">
          <span>Session title <span className="muted">(optional)</span></span>
          <input value={title} placeholder={`Work in ${project?.name ?? "this project"}`} onChange={(event) => setTitle(event.target.value)} />
        </label>

        <div className="worktree-mode-tabs" role="tablist" aria-label="Worktree source">
          <button role="tab" aria-selected={mode === "existing"} className={mode === "existing" ? "active" : ""}
            disabled={loading || linkedWorktrees.length === 0} onClick={() => setMode("existing")}>
            Existing worktree
          </button>
          <button role="tab" aria-selected={mode === "new"} className={mode === "new" ? "active" : ""}
            disabled={loading} onClick={() => setMode("new")}>
            New branch
          </button>
        </div>

        {loading ? <div className="empty">Loading worktrees…</div> : mode === "existing" ? (
          <>
            <input
              className="worktree-search"
              value={query}
              placeholder="Filter by branch or path…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="worktree-choice-list" role="radiogroup" aria-label="Existing worktrees">
              {filtered.map((worktree) => (
                <label className={`worktree-choice ${selectedPath === worktree.path ? "selected" : ""}`} key={worktree.path}>
                  <input
                    type="radio"
                    name="worktree"
                    checked={selectedPath === worktree.path}
                    onChange={() => setSelectedPath(worktree.path)}
                  />
                  <span>
                    <strong>{worktreeLabel(worktree.branch, worktree.path)}</strong>
                    <small>{worktree.path}</small>
                  </span>
                </label>
              ))}
              {filtered.length === 0 && <div className="empty">No linked worktrees match.</div>}
            </div>
          </>
        ) : (
          <label className="worktree-session-field">
            <span>Branch</span>
            <input
              className="mono"
              value={branch}
              placeholder={suggestion}
              onChange={(event) => { setBranch(event.target.value); setBranchTouched(true); }}
            />
            <small className="muted">Suggested from <code>{template || "feat/{slug}"}</code>. The checkout folder is created automatically.</small>
          </label>
        )}

        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>

      <div className="dialog-foot">
        <span className="muted">{progress || (mode === "new" ? "The worktree is created before the session is registered." : "The existing checkout is reused.")}</span>
        <span className="header-spacer" />
        <button className="small-btn" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary-btn" disabled={busy || loading || (mode === "existing" ? !selectedPath : !branch.trim())} onClick={() => void submit()}>
          {busy ? "Preparing…" : "Continue to composer"}
        </button>
      </div>
    </Dialog>
  );
}
