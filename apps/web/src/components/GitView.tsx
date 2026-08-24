// Changes-first Git surface (WP7): grouped file changes with folder actions up
// top, then branches/worktrees, then a commit graph with refs and pagination.
// The right pane shows hunk-by-hunk diffs where local review comments anchor
// by content digest and turn Outdated when the source moves on.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type GitBranches, type GitFileEntry, type GitGraphEntry, type GitStash, type Worktree } from "../api.ts";
import { openWorktreeSessionDialog, useStore, setGitBranch, setUiError } from "../store.ts";
import { setPaneLastResource } from "../workspace/panePrefs.ts";
import { diffStat } from "../utils.ts";
import { friendlyError } from "../settings.ts";
import { layoutGraph, type GraphRow } from "../git/graph.ts";
import {
  commentState, hunkDigest, loadComments, saveComments, splitHunks,
  type DiffHunk, type ReviewComment,
} from "../review/anchors.ts";
import CopyButton from "./CopyButton.tsx";
import EmptyState from "./EmptyState.tsx";
import PrCreatePanel from "./PrCreatePanel.tsx";
import { setGitPrefs, splitDiffRows, useGitPrefs } from "../gitPrefs.ts";
import { refreshGitStatus, useGitStatus } from "../gitStatusStore.ts";
import { Icon } from "../icons.tsx";

const STATUS_LETTER: Record<string, { letter: string; cls: string; label: string }> = {
  added: { letter: "A", cls: "staged", label: "Added" },
  modified: { letter: "M", cls: "unstaged", label: "Modified" },
  deleted: { letter: "D", cls: "unstaged", label: "Deleted" },
  renamed: { letter: "R", cls: "staged", label: "Renamed" },
  copied: { letter: "C", cls: "staged", label: "Copied" },
  typechange: { letter: "T", cls: "unstaged", label: "Type changed" },
  untracked: { letter: "?", cls: "unstaged", label: "Untracked" },
  conflicted: { letter: "!", cls: "conflict", label: "Conflicted" },
};

function fileLetter(f: GitFileEntry): { letter: string; cls: string; label: string } {
  const hit = STATUS_LETTER[f.status];
  if (hit) return f.staged && f.status !== "conflicted" ? { ...hit, cls: "staged" } : hit;
  return { letter: "M", cls: f.staged ? "staged" : "unstaged", label: "Modified" };
}

function GitFileMain({ file, onOpen }: { file: GitFileEntry; onOpen: () => void }) {
  const { letter, cls, label } = fileLetter(file);
  return (
    <button type="button" className="git-file-main" onClick={onOpen}>
      <span className={`git-file-letter ${cls}`} title={label} aria-label={label}>{letter}</span>
      <span className="git-file-path" title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
        {file.origPath ? <><span className="muted">{file.origPath} → </span>{file.path}</> : file.path}
      </span>
    </button>
  );
}

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");

/** Typed confirmation for destructive bulk actions. */
function confirmTyped(what: string): boolean {
  const typed = window.prompt(`This cannot be undone. Type "discard" to ${what}:`);
  return typed?.trim().toLowerCase() === "discard";
}

const GRAPH_PAGE = 30;
const LANE_W = 12;

function GraphSvg({ row }: { row: GraphRow }) {
  const width = Math.max(row.width, 1) * LANE_W;
  const cx = row.lane * LANE_W + LANE_W / 2;
  return (
    <svg className="graph-svg" width={width} height={24} aria-hidden="true">
      {row.through.map((l) => (
        <line key={`t${l}`} x1={l * LANE_W + LANE_W / 2} y1={0} x2={l * LANE_W + LANE_W / 2} y2={24} className="graph-line" />
      ))}
      {row.edges.map((l, i) => (
        <line key={`e${i}`} x1={cx} y1={12} x2={l * LANE_W + LANE_W / 2} y2={24} className="graph-line" />
      ))}
      <line x1={cx} y1={0} x2={cx} y2={12} className="graph-line" opacity={row.lane === 0 && row.through.length === 0 && row.edges.length <= 1 ? 0.6 : 1} />
      <circle cx={cx} cy={12} r={3.5} className={row.edges.length > 1 ? "graph-dot merge" : "graph-dot"} />
    </svg>
  );
}

export default function GitView() {
  const projectId = useStore((s) => s.activeProjectId);
  const sessionId = useStore((s) => s.activeSessionId);
  const diffPath = useStore((s) => s.gitDiffPath);
  const status = useGitStatus(projectId, false, sessionId);
  const [branches, setBranches] = useState<GitBranches>({ current: "", branches: [] });
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [graph, setGraph] = useState<GitGraphEntry[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [graphDone, setGraphDone] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [commitSel, setCommitSel] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [newTree, setNewTree] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [showTreeForm, setShowTreeForm] = useState(false);
  const [showPrForm, setShowPrForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<{ digest: string; line: number } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [syncSteps, setSyncSteps] = useState<Array<{ step: "fetch" | "pull" | "push"; error?: string }>>([]);
  const prefs = useGitPrefs();

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const [s, b, w, g, stashRows] = await Promise.all([
        refreshGitStatus(projectId, sessionId),
        api.gitBranches(projectId, sessionId ?? undefined),
        api.listWorktrees(projectId),
        api.gitGraph(projectId, GRAPH_PAGE, 0, sessionId ?? undefined),
        api.gitStashes(projectId, sessionId ?? undefined),
      ]);
      if (!s) throw new Error("git status unavailable");
      setBranches(b);
      setTrees(w);
      setGraph(g);
      setStashes(stashRows);
      setGraphDone(g.length < GRAPH_PAGE);
      setLoadError(false);
      if (b.current) setGitBranch(b.current);
    } catch {
      setLoadError(true);
    }
  }, [projectId, sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // openChanges(path) channel: selecting a changed file elsewhere (sidebar,
  // chat file pills, adapters) selects that exact diff in THIS canonical
  // instance — there is no separate reduced changes implementation.
  useEffect(() => {
    if (diffPath) {
      setCommitSel(null);
      setSel(diffPath);
    }
  }, [diffPath]);

  // The selected diff is the surface's provider resource (project-scoped).
  useEffect(() => {
    if (projectId && sel) setPaneLastResource(projectId, "git", `changes:${sel}`);
  }, [projectId, sel]);

  useEffect(() => {
    setComments(projectId ? loadComments(projectId) : []);
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !sel || !status) return;
    const staged = status.staged.some((f) => f.path === sel);
    void api.gitDiff(projectId, sel, staged, prefs.ignoreWhitespace, sessionId ?? undefined).then((d) => setDiff(d.diff));
    setDraft(null);
  }, [projectId, sessionId, sel, status, prefs.ignoreWhitespace]);

  useEffect(() => {
    if (!projectId || !commitSel) return;
    void api.gitShow(projectId, commitSel, prefs.ignoreWhitespace, sessionId ?? undefined)
      .then((result) => setCommitDiff(result.diff))
      .catch((err) => setUiError(friendlyError("Couldn’t load the commit diff", err)));
  }, [projectId, sessionId, commitSel, prefs.ignoreWhitespace]);

  const hunks = useMemo(() => splitHunks(diff), [diff]);
  const graphRows = useMemo(() => layoutGraph(graph), [graph]);

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to inspect its git state." />;
  if (loadError) return <EmptyState title="Not a git repository" description="Git data could not be loaded for this project." />;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setUiError(friendlyError("Couldn’t update the repository", e));
    } finally {
      setBusy(false);
    }
  };

  const all = status ? [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted] : [];
  const { add: addCount, del: delCount } = diffStat(diff);

  // ---- folder grouping (changes-first surface) --------------------------------
  const groups = new Map<string, GitFileEntry[]>();
  for (const f of all) {
    const d = dirOf(f.path);
    const list = groups.get(d) ?? [];
    list.push(f);
    groups.set(d, list);
  }
  const groupKeys = [...groups.keys()].sort();

  const persistComments = (next: ReviewComment[]) => {
    setComments(next);
    saveComments(projectId, next);
  };

  const fileComments = comments.filter((c) => c.path === sel);

  const loadMoreGraph = async () => {
    const more = await api.gitGraph(projectId, GRAPH_PAGE, graph.length, sessionId ?? undefined);
    setGraph((g) => [...g, ...more]);
    if (more.length < GRAPH_PAGE) setGraphDone(true);
  };

  const syncRepository = async () => {
    setBusy(true);
    const results: Array<{ step: "fetch" | "pull" | "push"; error?: string }> = [];
    for (const [step, action] of [
      ["fetch", api.gitFetch],
      ["pull", api.gitPull],
      ["push", api.gitPush],
    ] as const) {
      try {
        await action(projectId, "origin", sessionId ?? undefined);
        results.push({ step });
      } catch (err) {
        results.push({ step, error: err instanceof Error ? err.message : String(err) });
      }
      setSyncSteps([...results]);
    }
    await refresh();
    setBusy(false);
  };

  return (
    <div className="view-page git-page">
      <div className="goals-head workspace-toolbar">
        <h1 className="view-title">Git &amp; Worktrees</h1>
        <span className="header-spacer" />
        <button className="small-btn icon-only" title="Sync repository" aria-label="Sync repository" disabled={busy} onClick={() => void syncRepository()}><Icon.sync /></button>
        <button className="small-btn icon-only" title="New worktree session" aria-label="New worktree session" onClick={() => openWorktreeSessionDialog(projectId)}><Icon.session /></button>
        <button className={`small-btn icon-only ${showBranchForm ? "active" : ""}`} title="New branch" aria-label="New branch" aria-pressed={showBranchForm} onClick={() => { setShowBranchForm((v) => !v); setShowTreeForm(false); setShowPrForm(false); }}><Icon.branch /></button>
        <button className={`small-btn icon-only ${showTreeForm ? "active" : ""}`} title="New worktree" aria-label="New worktree" aria-pressed={showTreeForm} onClick={() => { setShowTreeForm((v) => !v); setShowBranchForm(false); setShowPrForm(false); }}><Icon.worktree /></button>
        <button className={`small-btn icon-only ${showPrForm ? "active" : ""}`} title="Create pull request" aria-label="Create pull request" aria-pressed={showPrForm} onClick={() => { setShowPrForm((v) => !v); setShowBranchForm(false); setShowTreeForm(false); }}><Icon.pullRequest /></button>
      </div>
      {syncSteps.length > 0 && (
        <div className="git-sync-steps" role="status">
          {syncSteps.map((result) => (
            <span key={result.step} className={result.error ? "err" : "ok"} title={result.error}>
              {result.error ? "✕" : "✓"} {result.step}{result.error ? `: ${result.error}` : ""}
            </span>
          ))}
        </div>
      )}

      {showBranchForm && (
        <div className="view-toolbar-row">
          <input value={newBranch} placeholder="new-branch-name" onChange={(e) => setNewBranch(e.target.value)} />
          <button className="small-btn" disabled={busy || !newBranch.trim()}
            onClick={() => void run(async () => { await api.gitBranch(projectId, newBranch.trim(), undefined, sessionId ?? undefined); setNewBranch(""); setShowBranchForm(false); })}>
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
      {showPrForm && (
        <PrCreatePanel
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => setShowPrForm(false)}
        />
      )}

      <div className="git-grid">
        <div className="git-col">
          {/* ---- changes first ------------------------------------------------ */}
          <div className="stat-label git-changes-head workspace-toolbar">
            <span>Changes ({all.length})</span>
            {status && all.length > 0 && (
              <span className="git-ahead-behind">
                {status.staged.length > 0 && <span className="ahead">{status.staged.length} staged</span>}
                {status.unstaged.length + status.untracked.length > 0 && <span className="behind">{status.unstaged.length + status.untracked.length} unstaged</span>}
                {status.conflicted.length > 0 && <span style={{ color: "var(--red)" }}>{status.conflicted.length} conflicted</span>}
              </span>
            )}
            <span className="header-spacer" />
            <button className={`small-btn icon-only ${prefs.changesView === "flat" ? "active" : ""}`} title="Flat view" aria-label="Flat view" aria-pressed={prefs.changesView === "flat"} onClick={() => setGitPrefs({ changesView: "flat" })}><Icon.list /></button>
            <button className={`small-btn icon-only ${prefs.changesView === "tree" ? "active" : ""}`} title="Tree view" aria-label="Tree view" aria-pressed={prefs.changesView === "tree"} onClick={() => setGitPrefs({ changesView: "tree" })}><Icon.hierarchy /></button>
            {status && (status.unstaged.length + status.untracked.length) > 0 && (
              <button className="small-btn icon-only" title="Stage all" aria-label="Stage all" disabled={busy}
                onClick={() => void run(() => api.gitFolder(projectId, "", "stage", sessionId ?? undefined))}>
                <Icon.stage />
              </button>
            )}
            {status && status.staged.length > 0 && (
              <button className="small-btn icon-only" title="Unstage all" aria-label="Unstage all" disabled={busy}
                onClick={() => void run(() => api.gitFolder(projectId, "", "unstage", sessionId ?? undefined))}>
                <Icon.unstage />
              </button>
            )}
          </div>
          <div className="git-changes">
            {all.length === 0 && <div className="muted" style={{ fontSize: "calc(12.5px * var(--ui-font-scale, 1))", padding: "4px 0" }}>Working tree clean.</div>}
            {prefs.changesView === "flat" && all.map((f) => {
              return (
                <div key={`${f.path}:${f.staged}`} className={`git-file-row ${sel === f.path ? "selected" : ""}`}>
                  <GitFileMain file={f} onOpen={() => { setCommitSel(null); setSel(f.path); }} />
                  <span className="git-file-actions">
                    {f.staged
                      ? <button className="small-btn icon-only" title="Unstage" aria-label={`Unstage ${f.path}`} disabled={busy} onClick={() => void run(() => api.gitUnstage(projectId, [f.path], sessionId ?? undefined))}><Icon.unstage /></button>
                      : <button className="small-btn icon-only" title="Stage" aria-label={`Stage ${f.path}`} disabled={busy} onClick={() => void run(() => api.gitStage(projectId, [f.path], sessionId ?? undefined))}><Icon.stage /></button>}
                    {!f.staged && f.status !== "untracked" && (
                      <button className="small-btn icon-only danger-btn" title="Discard" aria-label={`Discard ${f.path}`} disabled={busy}
                        onClick={() => { if (window.confirm(`Discard ${f.path}?`)) void run(() => api.gitDiscard(projectId, [f.path], sessionId ?? undefined)); }}><Icon.trash /></button>
                    )}
                  </span>
                </div>
              );
            })}
            {prefs.changesView === "tree" && groupKeys.map((dir) => {
              const files = groups.get(dir)!;
              const open = !collapsed.has(dir);
              return (
                <div key={dir || "."} className="git-folder-group">
                  <div className="git-folder-row">
                    <button
                      className="git-folder-toggle"
                      aria-expanded={open}
                      onClick={() => setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(dir)) n.delete(dir); else n.add(dir);
                        return n;
                      })}
                    >
                      <span className="git-folder-chevron" aria-hidden="true">{open ? <Icon.chevronDown /> : <Icon.chevronRight />}</span>
                      <span className="mono">{dir || "(root)"}</span> <span className="muted">({files.length})</span>
                    </button>
                    <span className="git-file-actions">
                      {files.some((f) => !f.staged && f.status !== "conflicted") && (
                        <button className="small-btn icon-only" title="Stage folder" aria-label={`Stage ${dir || "root"} folder`} disabled={busy}
                          onClick={() => void run(() => api.gitFolder(projectId, dir, "stage", sessionId ?? undefined))}><Icon.stage /></button>
                      )}
                      {files.some((f) => f.staged) && (
                        <button className="small-btn icon-only" title="Unstage folder" aria-label={`Unstage ${dir || "root"} folder`} disabled={busy}
                          onClick={() => void run(() => api.gitFolder(projectId, dir, "unstage", sessionId ?? undefined))}><Icon.unstage /></button>
                      )}
                      {files.some((f) => !f.staged) && (
                        <button className="small-btn icon-only danger-btn" title="Discard folder changes" aria-label={`Discard changes in ${dir || "root"} folder`} disabled={busy}
                          onClick={() => { if (confirmTyped(`discard all changes under ${dir || "the repository root"}`)) void run(() => api.gitFolder(projectId, dir, "discard", sessionId ?? undefined)); }}><Icon.trash /></button>
                      )}
                    </span>
                  </div>
                  {open && files.map((f) => {
                    return (
                      <div key={`${f.path}:${f.staged}`} className={`git-file-row ${sel === f.path ? "selected" : ""}`}>
                        <GitFileMain file={f} onOpen={() => { setCommitSel(null); setSel(f.path); }} />
                        <span className="git-file-actions">
                          {f.staged
                            ? <button className="small-btn icon-only" title="Unstage" aria-label={`Unstage ${f.path}`} disabled={busy} onClick={() => void run(() => api.gitUnstage(projectId, [f.path], sessionId ?? undefined))}><Icon.unstage /></button>
                            : <button className="small-btn icon-only" title="Stage" aria-label={`Stage ${f.path}`} disabled={busy} onClick={() => void run(() => api.gitStage(projectId, [f.path], sessionId ?? undefined))}><Icon.stage /></button>}
                          {!f.staged && f.status !== "untracked" && (
                            <button className="small-btn icon-only danger-btn" title="Discard" aria-label={`Discard ${f.path}`} disabled={busy}
                              onClick={() => { if (window.confirm(`Discard ${f.path}?`)) void run(() => api.gitDiscard(projectId, [f.path], sessionId ?? undefined)); }}><Icon.trash /></button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

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
          {(() => {
            // LOCAL/REMOTE sections; bare remote refs (e.g. "origin") are dropped (UX-27).
            const others = branches.branches.filter((b) => !b.current);
            const local = others.filter((b) => !b.remote);
            const remote = others.filter((b) => b.remote && b.name !== b.remote && !b.name.endsWith("/HEAD"));
            const section = (label: string, list: typeof others) => list.length > 0 && (
              <div className="git-branch-list">
                <div className="stat-label">{label}</div>
                {list.map((b) => (
                  <button key={b.name} className="git-branch-row" disabled={busy} title={b.name}
                    onClick={() => void run(() => api.gitCheckout(projectId, b.name, sessionId ?? undefined))}>
                    <span className="mono">{b.name}</span>
                  </button>
                ))}
              </div>
            );
            return <>{section("Local", local)}{section("Remote", remote)}</>;
          })()}

          <div className="stat-label">Worktrees ({trees.length})</div>
          {trees.length === 0 && <div className="muted" style={{ fontSize: "calc(12.5px * var(--ui-font-scale, 1))" }}>No linked worktrees — sessions run in the project root.</div>}
          {trees.map((t) => (
            <div key={t.path} className="git-wt-card">
              <div className="mono" style={{ fontWeight: 600 }}>
                {t.branch}
                <span className={`ctx-badge ${t.isMain ? "green" : ""}`} style={{ marginLeft: 6 }}>{t.isMain ? "main" : "linked"}</span>
              </div>
              <div className="muted" style={{ fontSize: "calc(11px * var(--ui-font-scale, 1))" }}>{t.path} · {t.head.slice(0, 7)}</div>
              {!t.isMain && (
                <div className="git-wt-actions">
                  <button className="small-btn icon-only git-wt-session" title="New session" aria-label={`New session in ${t.branch}`} disabled={busy} onClick={() => openWorktreeSessionDialog(projectId, t.path)}>
                    <Icon.session />
                  </button>
                  <button className="small-btn icon-only danger-btn git-wt-remove" title="Remove worktree" aria-label={`Remove worktree ${t.branch}`} disabled={busy}
                    onClick={() => { if (window.confirm(`Remove worktree ${t.path}?`)) void run(() => api.removeWorktree(projectId, t.path, true)); }}>
                    <Icon.trash />
                  </button>
                </div>
              )}
            </div>
          ))}

          <div className="stat-label">Stashes ({stashes.length})</div>
          <div className="view-toolbar-row">
            <input value={stashMessage} placeholder="stash message (optional)" onChange={(event) => setStashMessage(event.target.value)} />
            <button className="small-btn" disabled={busy || all.length === 0}
              onClick={() => void run(async () => { await api.gitStashPush(projectId, stashMessage.trim() || undefined, sessionId ?? undefined); setStashMessage(""); setSel(null); })}>
              Stash
            </button>
          </div>
          {stashes.map((stash) => (
            <div className="git-stash-row" key={stash.ref}>
              <span className="mono">{stash.ref}</span>
              <span className="git-subj" title={stash.message}>{stash.message.replace(/^On [^:]+:\s*/, "")}</span>
              <button className="small-btn" disabled={busy} onClick={() => void run(() => api.gitStashApply(projectId, stash.ref, sessionId ?? undefined))}>Apply</button>
              <button className="small-btn danger-btn" disabled={busy}
                onClick={() => { if (window.confirm(`Drop ${stash.ref}?`)) void run(() => api.gitStashDrop(projectId, stash.ref, sessionId ?? undefined)); }}>
                Drop
              </button>
            </div>
          ))}

          {/* ---- commit graph -------------------------------------------------- */}
          <div className="stat-label">Graph</div>
          {graph.length === 0 && <div className="muted" style={{ fontSize: "calc(12.5px * var(--ui-font-scale, 1))" }}>No commits yet.</div>}
          <div className="git-graph">
            {graph.map((c, i) => (
              <button key={c.sha} className={`git-graph-row ${commitSel === c.sha ? "selected" : ""}`}
                title={`${c.author} · ${new Date(c.date).toLocaleString()}${c.parents.length > 1 ? " · merge" : ""}`}
                onClick={() => { setSel(null); setCommitSel(c.sha); }}>
                {graphRows[i] && <GraphSvg row={graphRows[i]!} />}
                <span className="git-sha">{c.shortSha}</span>
                {c.refs.map((r) => (
                  <span key={r} className={`graph-ref${r.startsWith("tag: ") ? " tag" : ""}`}>{r.replace(/^tag: /, "⌂ ")}</span>
                ))}
                <span className="git-subj">{c.subject}</span>
              </button>
            ))}
          </div>
          {!graphDone && graph.length > 0 && (
            <button className="small-btn" onClick={() => void loadMoreGraph()}>Load more…</button>
          )}
        </div>

        <div className="git-col git-col-right">
          {commitSel ? (
            <>
              <div className="wt-file" title={commitSel}>
                Commit {graph.find((commit) => commit.sha === commitSel)?.shortSha ?? commitSel.slice(0, 7)}
                {" · "}{graph.find((commit) => commit.sha === commitSel)?.subject ?? ""}
              </div>
              <DiffPrefsToolbar />
              <DiffContent diff={commitDiff} split={prefs.layout === "split"} wrap={prefs.wrap} />
            </>
          ) : all.length === 0 ? (
            <EmptyState title="No changes" description="The working tree is clean. Edits in this project will show up here." />
          ) : sel === null ? (
            <EmptyState title="Pick a file" description="Select a changed file to view its diff." />
          ) : (
            <>
              <div className="wt-file" title={sel}>{sel}</div>
              <DiffPrefsToolbar />
              {prefs.layout === "split" ? (
                <DiffContent diff={diff} split wrap={prefs.wrap} />
              ) : <div className="copy-wrap">
                <pre className={`git-diff git-diff-page${prefs.wrap ? " wrap" : ""}`}>
                  {hunks.length === 0 && diff.split("\n").map((line, i) => (
                    <div key={i} className="git-diff-line">
                      <span className="git-diff-ln">{i + 1}</span>
                      <span>{line}</span>
                    </div>
                  ))}
                  {hunks.map((h, hi) => (
                    <HunkBlock
                      key={hi}
                      hunk={h}
                      onComment={() => { setDraft({ digest: hunkDigest(h), line: h.startNew }); setDraftText(""); }}
                    />
                  ))}
                </pre>
                <CopyButton text={diff} />
              </div>}

              {draft && (
                <div className="review-draft">
                  <textarea
                    autoFocus
                    rows={2}
                    placeholder={`Review note near line ${draft.line}…`}
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                  />
                  <div className="commit-row">
                    <button className="small-btn" onClick={() => setDraft(null)}>Cancel</button>
                    <button className="primary-btn" style={{ padding: "4px 12px", fontSize: "calc(12px * var(--ui-font-scale, 1))" }} disabled={!draftText.trim()}
                      onClick={() => {
                        persistComments([
                          ...comments,
                          { id: `rc_${Date.now().toString(36)}`, path: sel, digest: draft.digest, line: draft.line, text: draftText.trim(), createdAt: Date.now() },
                        ]);
                        setDraft(null);
                      }}>
                      Add note
                    </button>
                  </div>
                </div>
              )}

              {fileComments.length > 0 && (
                <div className="review-list">
                  <div className="stat-label">Review notes ({fileComments.length})</div>
                  {fileComments.map((c) => {
                    const state = commentState(c, hunks);
                    return (
                      <div key={c.id} className={`review-note${state === "outdated" ? " outdated" : ""}`}>
                        <div className="review-note-head">
                          <span className="mono">L{c.line}</span>
                          {state === "outdated" && <span className="tag">Outdated</span>}
                          <span className="header-spacer" />
                          <button className="small-btn icon-only" title="Remove review note" aria-label="Remove review note" onClick={() => persistComments(comments.filter((x) => x.id !== c.id))}><Icon.close /></button>
                        </div>
                        <div className="review-note-text">{c.text}</div>
                      </div>
                    );
                  })}
                </div>
              )}
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
                  onClick={() => { setGenerating(true); void api.gitCommitMessage(projectId, sessionId ?? undefined).then((r) => { if (r.message) setCommitMsg(r.message); }).finally(() => setGenerating(false)); }}>
                  {generating ? "…" : "✦ Generate with AI"}
                </button>
                <button className="primary-btn" style={{ padding: "5px 14px", fontSize: "calc(12px * var(--ui-font-scale, 1))" }}
                  disabled={!commitMsg.trim() || busy}
                  onClick={() => void run(async () => { await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined); setCommitMsg(""); setSel(null); })}>
                  Commit
                </button>
              </div>
            </div>
          )}
          {sel && (addCount + delCount > 0) && (
            <div className="muted" style={{ fontSize: "calc(11.5px * var(--ui-font-scale, 1))" }}>
              <span style={{ color: "var(--green)" }}>+{addCount}</span>{" "}
              <span style={{ color: "var(--red)" }}>-{delCount}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HunkBlock({ hunk, onComment }: { hunk: DiffHunk; onComment: () => void }) {
  let ln = hunk.startNew;
  return (
    <>
      <div className="git-diff-line diff-hunk">
        <span className="git-diff-ln" />
        <span>{hunk.header}</span>
        <button className="hunk-comment-btn" title="Add review note for this hunk" onClick={onComment}>💬</button>
      </div>
      {hunk.body.map((line, i) => {
        let cls = "";
        let shown = "";
        if (line.startsWith("+")) { cls = "diff-add"; shown = String(ln++); }
        else if (line.startsWith("-")) { cls = "diff-del"; }
        else { shown = String(ln++); }
        return (
          <div key={i} className={`git-diff-line ${cls}`}>
            <span className="git-diff-ln">{shown}</span>
            <span>{line}</span>
          </div>
        );
      })}
    </>
  );
}

function DiffPrefsToolbar() {
  const prefs = useGitPrefs();
  return (
    <div className="diff-prefs">
      <button className={`small-btn ${prefs.layout === "unified" ? "active" : ""}`} onClick={() => setGitPrefs({ layout: "unified" })}>Unified</button>
      <button className={`small-btn ${prefs.layout === "split" ? "active" : ""}`} onClick={() => setGitPrefs({ layout: "split" })}>Split</button>
      <label><input type="checkbox" checked={prefs.ignoreWhitespace} onChange={(event) => setGitPrefs({ ignoreWhitespace: event.target.checked })} /> Ignore whitespace</label>
      <label><input type="checkbox" checked={prefs.wrap} onChange={(event) => setGitPrefs({ wrap: event.target.checked })} /> Wrap</label>
    </div>
  );
}

function DiffContent({ diff, split, wrap }: { diff: string; split: boolean; wrap: boolean }) {
  if (!diff) return <div className="empty" style={{ padding: 12 }}>No diff.</div>;
  if (!split) {
    return (
      <div className="copy-wrap">
        <pre className={`git-diff git-diff-page${wrap ? " wrap" : ""}`}>{diff}</pre>
        <CopyButton text={diff} />
      </div>
    );
  }
  return (
    <div className="copy-wrap">
      <div className={`split-diff${wrap ? " wrap" : ""}`}>
        {splitDiffRows(diff).map((row, index) => (
          <div className={`split-diff-row ${row.kind}`} key={index}>
            <code className={row.left.startsWith("-") ? "diff-del" : ""}>{row.left}</code>
            <code className={row.right.startsWith("+") ? "diff-add" : ""}>{row.right}</code>
          </div>
        ))}
      </div>
      <CopyButton text={diff} />
    </div>
  );
}
