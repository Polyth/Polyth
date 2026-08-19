import { useCallback, useEffect, useState } from "react";
import { api, type GitBranches, type GitStatus, type Worktree } from "../api.ts";
import { useStore, setGitBranch } from "../store.ts";

function fileLetter(staged: boolean, status: string): { letter: string; cls: string } {
  if (status === "conflict") return { letter: "!", cls: "conflict" };
  if (status === "untracked") return { letter: "?", cls: "unstaged" };
  if (staged) return { letter: "A", cls: "staged" };
  return { letter: "M", cls: "unstaged" };
}

export default function GitView() {
  const projectId = useStore((s) => s.activeProjectId);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [newTree, setNewTree] = useState("");
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [showTreeForm, setShowTreeForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const [s, b, w] = await Promise.all([
      api.gitStatus(projectId),
      api.gitBranches(projectId),
      api.listWorktrees(projectId),
    ]);
    setStatus(s);
    setBranches(b);
    setTrees(w);
    if (b.current) setGitBranch(b.current);
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!projectId || !sel || !status) return;
    const staged = status.staged.some((f) => f.path === sel);
    void api.gitDiff(projectId, sel, staged).then((d) => setDiff(d.diff));
  }, [projectId, sel, status]);

  if (!projectId) return <div className="view-empty">Select a project to inspect git.</div>;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch((e) => window.alert(String(e)));
    await refresh();
    setBusy(false);
  };

  const all = status ? [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted] : [];
  const addCount = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const delCount = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  return (
    <div className="view-page git-page">
      <div className="goals-head">
        <h1 className="view-title">Git &amp; Worktrees</h1>
        <span className="header-spacer" />
        <button className="small-btn" onClick={() => { setShowBranchForm((v) => !v); setShowTreeForm(false); }}>+ Branch</button>
        <button className="small-btn" onClick={() => { setShowTreeForm((v) => !v); setShowBranchForm(false); }}>+ Worktree</button>
      </div>

      {showBranchForm && (
        <div className="view-toolbar-row">
          <input value={newBranch} placeholder="new-branch-name" onChange={(e) => setNewBranch(e.target.value)} />
          <button className="small-btn" disabled={busy || !newBranch.trim()}
            onClick={() => void run(async () => { await api.gitBranch(projectId, newBranch.trim()); setNewBranch(""); setShowBranchForm(false); })}>
            Create
          </button>
        </div>
      )}
      {showTreeForm && (
        <div className="view-toolbar-row">
          <input value={newTree} placeholder="branch for the worktree" onChange={(e) => setNewTree(e.target.value)} />
          <button className="small-btn" disabled={busy || !newTree.trim()}
            onClick={() => void run(async () => { await api.createWorktree(projectId, newTree.trim()); setNewTree(""); setShowTreeForm(false); })}>
            Create
          </button>
        </div>
      )}

      <div className="git-grid">
        <div className="git-col">
          <div className="stat-label">Branch</div>
          <div className="git-branch-card">
            <span className="mono" style={{ fontWeight: 650 }}>{status?.branch || "—"}</span>
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="git-ahead-behind">
                {status.ahead > 0 && <span className="ahead">↑{status.ahead}</span>}
                {status.behind > 0 && <span className="behind">↓{status.behind}</span>}
              </span>
            )}
          </div>
          {branches.branches.filter((b) => !b.current).length > 0 && (
            <div className="git-branch-list">
              {branches.branches.filter((b) => !b.current).map((b) => (
                <button key={b.name} className="git-branch-row" disabled={busy}
                  onClick={() => void run(() => api.gitCheckout(projectId, b.name))}>
                  <span className="mono">{b.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className="stat-label">Worktrees</div>
          {trees.map((t) => (
            <div key={t.path} className="git-wt-card">
              <div className="mono" style={{ fontWeight: 600 }}>{t.branch}</div>
              <div className="muted" style={{ fontSize: 11 }}>{t.path} · {t.head.slice(0, 7)}</div>
              {!t.isMain && (
                <button className="small-btn danger-btn git-wt-remove" disabled={busy}
                  onClick={() => { if (window.confirm(`Remove worktree ${t.path}?`)) void run(() => api.removeWorktree(projectId, t.path, true)); }}>
                  Remove
                </button>
              )}
            </div>
          ))}

          <div className="stat-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Changes ({all.length})</span>
            {status && (status.unstaged.length + status.untracked.length) > 0 && (
              <button className="small-btn" disabled={busy}
                onClick={() => void run(() => api.gitStage(projectId, [...status.unstaged, ...status.untracked].map((f) => f.path)))}>
                Stage all
              </button>
            )}
          </div>
          <div className="git-changes">
            {all.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: "4px 0" }}>Working tree clean.</div>}
            {all.map((f) => {
              const { letter, cls } = fileLetter(f.staged, f.status);
              return (
                <div key={`${f.path}:${f.staged}`} className={`git-file-row ${sel === f.path ? "selected" : ""}`}
                  onClick={() => setSel(f.path)}>
                  <span className={`git-file-letter ${cls}`}>{letter}</span>
                  <span className="git-file-path">{f.path}</span>
                  <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
                    {f.staged
                      ? <button className="small-btn" title="Unstage" disabled={busy} onClick={() => void run(() => api.gitUnstage(projectId, [f.path]))}>U</button>
                      : <button className="small-btn" title="Stage" disabled={busy} onClick={() => void run(() => api.gitStage(projectId, [f.path]))}>S</button>}
                    {!f.staged && f.status !== "untracked" && (
                      <button className="small-btn danger-btn" title="Discard" disabled={busy}
                        onClick={() => { if (window.confirm(`Discard ${f.path}?`)) void run(() => api.gitDiscard(projectId, [f.path])); }}>✕</button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="git-col git-col-right">
          {sel === null ? (
            <div className="view-empty">Select a changed file to view its diff.</div>
          ) : (
            <>
              <div className="wt-file" title={sel}>{sel}</div>
              <pre className="git-diff git-diff-page">
                {diff.split("\n").map((line, i) => {
                  let cls = "";
                  if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
                  else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
                  else if (line.startsWith("@@")) cls = "diff-hunk";
                  return (
                    <div key={i} className={`git-diff-line ${cls}`}>
                      <span className="git-diff-ln">{i + 1}</span>
                      <span>{line}</span>
                    </div>
                  );
                })}
              </pre>
            </>
          )}

          {status && status.staged.length > 0 && (
            <div className="commit-area">
              <textarea
                className="commit-msg"
                rows={2}
                placeholder="Commit message…"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
              />
              <div className="commit-row">
                <button className="small-btn" disabled={generating || busy}
                  onClick={() => { setGenerating(true); void api.gitCommitMessage(projectId).then((r) => { if (r.message) setCommitMsg(r.message); }).finally(() => setGenerating(false)); }}>
                  {generating ? "…" : "✦ Generate with AI"}
                </button>
                <button className="primary-btn" style={{ padding: "5px 14px", fontSize: 12 }}
                  disabled={!commitMsg.trim() || busy}
                  onClick={() => void run(async () => { await api.gitCommit(projectId, commitMsg.trim()); setCommitMsg(""); setSel(null); })}>
                  Commit
                </button>
              </div>
            </div>
          )}
          {sel && (addCount + delCount > 0) && (
            <div className="muted" style={{ fontSize: 11.5 }}>
              <span style={{ color: "var(--green)" }}>+{addCount}</span>{" "}
              <span style={{ color: "var(--red)" }}>-{delCount}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
