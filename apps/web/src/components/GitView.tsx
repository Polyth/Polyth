import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type GitBranches, type GitFileEntry, type GitGraphEntry, type GitStash, type GitStatus, type Worktree } from "../api.ts";
import { layoutGraph, type GraphRow } from "../git/graph.ts";
import { setGitPrefs, splitDiffRows, useGitPrefs } from "../gitPrefs.ts";
import { refreshGitStatus, useGitStatus } from "../gitStatusStore.ts";
import { highlight, langOf } from "../highlight.ts";
import { Icon } from "../icons.tsx";
import { splitPrDiff } from "../prDiff.ts";
import {
  commentState, hunkDigest, loadComments, saveComments, splitHunks,
  type DiffHunk, type ReviewComment,
} from "../review/anchors.ts";
import { friendlyError } from "../settings.ts";
import { openWorktreeSessionDialog, setGitBranch, setUiError, useStore } from "../store.ts";
import { diffStat } from "../utils.ts";
import { setPaneLastResource } from "../workspace/panePrefs.ts";
import CopyButton from "./CopyButton.tsx";
import Dialog from "./a11y/Dialog.tsx";
import EmptyState from "./EmptyState.tsx";
import PrCreatePanel from "./PrCreatePanel.tsx";

type GitTab = "changes" | "log" | "branches" | "stashes";
type RemoteStep = "fetch" | "pull" | "push";
type BranchGroup = "local" | "remote";
interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
}

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

const GRAPH_PAGE = 40;
const LANE_W = 12;

type GitSelection = { path: string; staged: boolean };

/** Keep an open diff attached to the file's current staged/unstaged location. */
export function reconcileGitSelection(selection: GitSelection | null, status: GitStatus): GitSelection | null {
  if (!selection) return null;
  const files = [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked];
  const exact = files.find((file) => file.path === selection.path && file.staged === selection.staged);
  const moved = files.find((file) => file.path === selection.path);
  const next = exact ?? moved;
  return next ? { path: next.path, staged: next.staged } : null;
}

function fileLetter(file: GitFileEntry): { letter: string; cls: string; label: string } {
  const hit = STATUS_LETTER[file.status];
  if (hit) return file.staged && file.status !== "conflicted" ? { ...hit, cls: "staged" } : hit;
  return { letter: "M", cls: file.staged ? "staged" : "unstaged", label: "Modified" };
}

function GraphSvg({ row }: { row: GraphRow }) {
  const width = Math.max(row.width, 1) * LANE_W;
  const cx = row.lane * LANE_W + LANE_W / 2;
  return (
    <svg className="graph-svg" width={width} height={32} aria-hidden="true">
      {row.through.map((lane) => (
        <line key={`t${lane}`} x1={lane * LANE_W + LANE_W / 2} y1={0} x2={lane * LANE_W + LANE_W / 2} y2={32} className="graph-line" />
      ))}
      {row.edges.map((lane, index) => (
        <line key={`e${index}`} x1={cx} y1={16} x2={lane * LANE_W + LANE_W / 2} y2={32} className="graph-line" />
      ))}
      <line x1={cx} y1={0} x2={cx} y2={16} className="graph-line" />
      <circle cx={cx} cy={16} r={4} className={row.edges.length > 1 ? "graph-dot merge" : "graph-dot"} />
    </svg>
  );
}

function GitFileRow({ file, selected, busy, onOpen, onStage, onDiscard }: {
  file: GitFileEntry;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
  onStage: () => void;
  onDiscard?: () => void;
}) {
  const { letter, cls, label } = fileLetter(file);
  return (
    <div className={`git-file-row ${selected ? "selected" : ""}`}>
      <button type="button" className="git-file-main" aria-current={selected ? "true" : undefined} onClick={onOpen}>
        <span className={`git-file-letter ${cls}`} title={label} aria-label={label}>{letter}</span>
        <span className="git-file-path" title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
          {file.origPath ? <><span className="muted">{file.origPath} → </span>{file.path}</> : file.path}
        </span>
      </button>
      <span className="git-file-actions">
        <button className="small-btn icon-only" title={file.staged ? "Unstage" : "Stage"} aria-label={`${file.staged ? "Unstage" : "Stage"} ${file.path}`} disabled={busy} onClick={onStage}>
          {file.staged ? <Icon.unstage /> : <Icon.stage />}
        </button>
        {onDiscard && (
          <button className="small-btn icon-only danger-btn" title="Discard" aria-label={`Discard ${file.path}`} disabled={busy} onClick={onDiscard}>
            <Icon.trash />
          </button>
        )}
      </span>
    </div>
  );
}

function ChangeSection({ id, title, files, closed, selected, busy, onToggle, onOpen, onStage, onDiscard }: {
  id: string;
  title: string;
  files: GitFileEntry[];
  closed: boolean;
  selected: { path: string; staged: boolean } | null;
  busy: boolean;
  onToggle: (id: string) => void;
  onOpen: (file: GitFileEntry) => void;
  onStage: (file: GitFileEntry) => void;
  onDiscard: (file: GitFileEntry) => void;
}) {
  return (
    <section className="git-change-group">
      <button className="git-change-group-head" type="button" aria-expanded={!closed} onClick={() => onToggle(id)}>
        <span className={`git-folder-chevron${closed ? "" : " expanded"}`} aria-hidden="true"><Icon.chevronRight /></span>
        <span>{title}</span>
        <span className="git-count">{files.length}</span>
      </button>
      {!closed && (
        <div className="git-change-group-body">
          {files.map((file) => (
            <GitFileRow
              key={`${id}:${file.path}`}
              file={file}
              selected={selected?.path === file.path && selected.staged === file.staged}
              busy={busy}
              onOpen={() => onOpen(file)}
              onStage={() => onStage(file)}
              {...(!file.staged && file.status !== "untracked" ? { onDiscard: () => onDiscard(file) } : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function GitView() {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const diffPath = useStore((state) => state.gitDiffPath);
  const status = useGitStatus(projectId, true, sessionId);
  const prefs = useGitPrefs();
  const [tab, setTab] = useState<GitTab>("changes");
  const [branches, setBranches] = useState<GitBranches>({ current: null, branches: [] });
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [graph, setGraph] = useState<GitGraphEntry[]>([]);
  const [stashes, setStashes] = useState<GitStash[]>([]);
  const [graphDone, setGraphDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<GitSelection | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [diffRetry, setDiffRetry] = useState(0);
  const [commitSel, setCommitSel] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState("");
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState("");
  const [commitDiffRetry, setCommitDiffRetry] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [newTree, setNewTree] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [showTreeForm, setShowTreeForm] = useState(false);
  const [showPrForm, setShowPrForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyRemote, setBusyRemote] = useState<RemoteStep | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<{ step: RemoteStep; error?: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(new Set());
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<{ digest: string; line: number } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [graphQuery, setGraphQuery] = useState("");
  const [graphRef, setGraphRef] = useState("");
  const [graphLoading, setGraphLoading] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [closedBranchGroups, setClosedBranchGroups] = useState<ReadonlySet<BranchGroup>>(new Set(["remote"]));
  const [branchLimits, setBranchLimits] = useState<Record<BranchGroup, number>>({ local: 30, remote: 30 });
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  const refresh = useCallback(async (showLoading = false): Promise<GitStatus | null> => {
    if (!projectId) return null;
    if (showLoading) setLoading(true);
    setLoadError("");
    let nextStatus: GitStatus | null = null;
    try {
      nextStatus = await refreshGitStatus(projectId, sessionId);
      if (!nextStatus) throw new Error("The Git service did not respond.");
      if (nextStatus.isRepo === false) {
        setBranches({ current: null, branches: [] });
        setTrees([]);
        setGraph([]);
        setStashes([]);
        return nextStatus;
      }
      const [nextBranches, nextTrees, nextGraph, nextStashes] = await Promise.all([
        api.gitBranches(projectId, sessionId ?? undefined),
        api.listWorktrees(projectId),
        api.gitGraph(projectId, GRAPH_PAGE, 0, sessionId ?? undefined),
        api.gitStashes(projectId, sessionId ?? undefined),
      ]);
      setBranches(nextBranches);
      setTrees(nextTrees);
      setGraph(nextGraph);
      setStashes(nextStashes);
      setGraphDone(nextGraph.length < GRAPH_PAGE);
      if (nextBranches.current) setGitBranch(nextBranches.current);
    } catch (cause) {
      setLoadError(friendlyError("Couldn’t load source control", cause));
    } finally {
      setLoading(false);
    }
    return nextStatus;
  }, [projectId, sessionId]);

  useEffect(() => {
    setSelected(null);
    setCommitSel(null);
    setMobileDetail(false);
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    setComments(projectId ? loadComments(projectId) : []);
  }, [projectId]);

  useEffect(() => {
    if (!diffPath || !status) return;
    const file = [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].find((candidate) => candidate.path === diffPath);
    setTab("changes");
    setCommitSel(null);
    setSelected({ path: diffPath, staged: file?.staged ?? false });
    setMobileDetail(true);
  }, [diffPath, status]);

  useEffect(() => {
    if (projectId && selected) setPaneLastResource(projectId, "git", `changes:${selected.path}`);
  }, [projectId, selected]);

  useEffect(() => {
    if (!projectId || !selected || status?.isRepo === false) return;
    let active = true;
    setDiff("");
    setDiffError("");
    setDiffLoading(true);
    setDraft(null);
    void api.gitDiff(projectId, selected.path, selected.staged, prefs.ignoreWhitespace, sessionId ?? undefined)
      .then((result) => { if (active) setDiff(result.diff); })
      .catch((cause) => {
        if (active) setDiffError(friendlyError("Couldn’t load the file diff", cause));
      })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; };
  }, [projectId, sessionId, selected, status?.isRepo, prefs.ignoreWhitespace, diffRetry]);

  useEffect(() => {
    if (!projectId || !commitSel) return;
    let active = true;
    setCommitDiff("");
    setCommitDiffError("");
    setCommitDiffLoading(true);
    void api.gitShow(projectId, commitSel, prefs.ignoreWhitespace, sessionId ?? undefined)
      .then((result) => { if (active) setCommitDiff(result.diff); })
      .catch((cause) => {
        if (active) setCommitDiffError(friendlyError("Couldn’t load the commit diff", cause));
      })
      .finally(() => { if (active) setCommitDiffLoading(false); });
    return () => { active = false; };
  }, [projectId, sessionId, commitSel, prefs.ignoreWhitespace, commitDiffRetry]);

  useEffect(() => {
    if (!remoteStatus) return;
    const timer = window.setTimeout(() => setRemoteStatus(null), remoteStatus.error ? 6_000 : 3_500);
    return () => window.clearTimeout(timer);
  }, [remoteStatus]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      const nextStatus = await refresh();
      if (nextStatus) {
        const nextSelected = reconcileGitSelection(selected, nextStatus);
        setSelected(nextSelected);
        if (selected && !nextSelected) setMobileDetail(false);
      }
    } catch (cause) {
      setUiError(friendlyError("Couldn’t update the repository", cause));
    } finally {
      setBusy(false);
    }
  };

  const runRemote = async (step: RemoteStep) => {
    if (!projectId) return;
    setBusyRemote(step);
    setRemoteStatus(null);
    try {
      const action = step === "fetch" ? api.gitFetch : step === "pull" ? api.gitPull : api.gitPush;
      await action(projectId, "origin", sessionId ?? undefined);
      setRemoteStatus({ step });
      await refresh();
    } catch (cause) {
      setRemoteStatus({ step, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusyRemote(null);
    }
  };

  const openFile = (file: GitFileEntry) => {
    setCommitSel(null);
    setSelected({ path: file.path, staged: file.staged });
    setMobileDetail(true);
  };

  const toggleGroup = (id: string) => {
    setClosedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const loadMoreGraph = async () => {
    if (!projectId || graphLoading) return;
    setGraphLoading(true);
    try {
      const more = await api.gitGraph(projectId, GRAPH_PAGE, graph.length, sessionId ?? undefined);
      setGraph((current) => [...current, ...more]);
      if (more.length < GRAPH_PAGE) setGraphDone(true);
    } catch (cause) {
      setUiError(friendlyError("Couldn’t load older commits", cause));
    } finally {
      setGraphLoading(false);
    }
  };

  const all = status ? [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked] : [];
  const hunks = useMemo(() => splitHunks(diff), [diff]);
  const graphRows = useMemo(() => layoutGraph(graph), [graph]);
  const branchChips = useMemo(() => {
    const refs = new Set<string>();
    for (const commit of graph) {
      for (const ref of commit.refs) {
        if (!ref.startsWith("tag: ")) refs.add(ref.replace(/^HEAD -> /, ""));
      }
    }
    return [...refs].slice(0, 12);
  }, [graph]);
  const visibleGraph = useMemo(() => {
    const query = graphQuery.trim().toLowerCase();
    return graph.map((commit, index) => ({ commit, row: graphRows[index] }))
      .filter(({ commit }) => {
        const refMatch = !graphRef || commit.refs.some((ref) => ref.replace(/^HEAD -> /, "") === graphRef);
        const queryMatch = !query || [commit.subject, commit.author, commit.shortSha, ...commit.refs].some((value) => value.toLowerCase().includes(query));
        return refMatch && queryMatch;
      });
  }, [graph, graphRows, graphQuery, graphRef]);
  const fileComments = comments.filter((comment) => comment.path === selected?.path);
  const selectedCommit = graph.find((commit) => commit.sha === commitSel);
  const commitDiffPath = useMemo(() => splitPrDiff(commitDiff)[0]?.path, [commitDiff]);
  const { add: addCount, del: delCount } = diffStat(diff);

  if (!projectId) return <EmptyState title="No project selected" description="Open a project to inspect its source control." />;

  if (loading && !status) {
    return (
      <div className="view-page git-page" aria-busy="true" aria-label="Loading source control">
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-tabs" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  if (loadError && !status) {
    return <EmptyState title="Source control unavailable" description={loadError} actionLabel="Retry" onAction={() => void refresh(true)} />;
  }

  if (status?.isRepo === false) {
    return (
      <div className="view-page git-page">
        <EmptyState
          title="This folder isn’t a Git repository"
          description="Initialize Git in this project or open a repository. Source control actions stay hidden until Git metadata is available."
          actionLabel="Check again"
          onAction={() => void refresh(true)}
        />
      </div>
    );
  }

  const changeGroups = [
    { id: "merge", title: "Merge Changes", files: status?.conflicted ?? [] },
    { id: "staged", title: "Staged Changes", files: status?.staged ?? [] },
    { id: "changes", title: "Changes", files: status?.unstaged ?? [] },
    { id: "untracked", title: "Untracked", files: status?.untracked ?? [] },
  ].filter((group) => group.files.length > 0);

  const persistComments = (next: ReviewComment[]) => {
    setComments(next);
    saveComments(projectId, next);
  };

  const selectTab = (next: GitTab) => {
    setTab(next);
    setMobileDetail(false);
  };

  return (
    <div className="view-page git-page">
      <header className="source-control-head">
        <div className="source-control-title">
          <h1 className="view-title">Source Control</h1>
          <span className="source-branch"><Icon.branch /> <span className="mono">{status?.branch || "detached HEAD"}</span></span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="git-ahead-behind">
              {status.ahead > 0 && <span className="ahead">↑ {status.ahead}</span>}
              {status.behind > 0 && <span className="behind">↓ {status.behind}</span>}
            </span>
          )}
        </div>
        <div className="source-remote-actions" aria-label="Remote repository actions">
          {(["fetch", "pull", "push"] as const).map((step) => (
            <button key={step} className="small-btn source-action-btn" disabled={busyRemote !== null || busy} onClick={() => void runRemote(step)}>
              {step === "fetch" ? <Icon.fetch /> : step === "pull" ? <Icon.pull /> : <Icon.push />}
              <span>{busyRemote === step ? `${step[0]!.toUpperCase()}${step.slice(1)}ing…` : `${step[0]!.toUpperCase()}${step.slice(1)}`}</span>
            </button>
          ))}
          <button className="small-btn icon-only" title="Refresh source control" aria-label="Refresh source control" disabled={busy || busyRemote !== null} onClick={() => void refresh()}>
            <Icon.refresh />
          </button>
        </div>
      </header>

      {remoteStatus && (
        <div className={`source-inline-status ${remoteStatus.error ? "error" : "success"}`} role={remoteStatus.error ? "alert" : "status"}>
          {remoteStatus.error
            ? `${remoteStatus.step} failed: ${remoteStatus.error}`
            : `${remoteStatus.step[0]!.toUpperCase()}${remoteStatus.step.slice(1)} completed.`}
        </div>
      )}

      {loadError && status && (
        <div className="source-inline-status error" role="alert">
          <span>{loadError}</span>
          <button className="small-btn" disabled={loading} onClick={() => void refresh(true)}>Retry</button>
        </div>
      )}

      {confirmRequest && (
        <Dialog title={confirmRequest.title} onClose={() => setConfirmRequest(null)} initialFocus=".danger-btn">
          <div className="source-confirm-dialog">
            <h2>{confirmRequest.title}</h2>
            <p>{confirmRequest.description}</p>
            <div className="source-confirm-dialog-actions">
              <button className="small-btn" onClick={() => setConfirmRequest(null)}>Cancel</button>
              <button className="primary-btn danger-btn" disabled={busy} onClick={() => {
                const request = confirmRequest;
                setConfirmRequest(null);
                void run(request.action);
              }}>{confirmRequest.confirmLabel}</button>
            </div>
          </div>
        </Dialog>
      )}

      <nav className="source-tabs" aria-label="Source control views">
        {([
          ["changes", `Changes${all.length ? ` ${all.length}` : ""}`],
          ["log", "Log"],
          ["branches", `Branches ${branches.branches.length}`],
          ["stashes", `Stashes ${stashes.length}`],
        ] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => selectTab(id)}>{label}</button>
        ))}
      </nav>

      {showBranchForm && (
        <div className="source-inline-form">
          <label htmlFor="git-new-branch">Create a branch</label>
          <input id="git-new-branch" className="mono" value={newBranch} placeholder="feature/branch-name" onChange={(event) => setNewBranch(event.target.value)} />
          <button className="primary-btn" disabled={busy || !newBranch.trim()} onClick={() => void run(async () => {
            await api.gitBranch(projectId, newBranch.trim(), undefined, sessionId ?? undefined);
            setNewBranch("");
            setShowBranchForm(false);
            setTab("branches");
          })}>Create branch</button>
          <button className="small-btn" onClick={() => setShowBranchForm(false)}>Cancel</button>
        </div>
      )}
      {showTreeForm && (
        <div className="source-inline-form">
          <label htmlFor="git-new-worktree">Create a worktree</label>
          <input id="git-new-worktree" className="mono" value={newTree} placeholder="branch for the worktree" onChange={(event) => setNewTree(event.target.value)} />
          <button className="primary-btn" disabled={busy || !newTree.trim()} onClick={() => void run(async () => {
            await api.createWorktree(projectId, newTree.trim());
            setNewTree("");
            setShowTreeForm(false);
            setTab("branches");
          })}>Create worktree</button>
          <button className="small-btn" onClick={() => setShowTreeForm(false)}>Cancel</button>
        </div>
      )}
      {showPrForm && <PrCreatePanel projectId={projectId} sessionId={sessionId} onClose={() => setShowPrForm(false)} />}

      {tab === "changes" && (
        <>
          <div className={`git-master-detail ${mobileDetail ? "detail-open" : ""}`}>
            <section className="git-master-pane" aria-label="Changed files">
              <div className="git-pane-toolbar">
                <div>
                  <strong>Working tree</strong>
                  <span className="muted">{all.length === 0 ? "Clean" : `${all.length} changed ${all.length === 1 ? "file" : "files"}`}</span>
                </div>
                <span className="header-spacer" />
                {(status?.unstaged.length || status?.untracked.length || status?.conflicted.length) ? (
                  <button className="small-btn" disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "stage", sessionId ?? undefined))}>
                    <Icon.stage /> Stage all
                  </button>
                ) : null}
                {status && status.staged.length > 0 && (
                  <button className="small-btn icon-only" title="Unstage all" aria-label="Unstage all" disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "unstage", sessionId ?? undefined))}>
                    <Icon.unstage />
                  </button>
                )}
              </div>
              <div className="git-change-groups">
                {changeGroups.map((group) => (
                  <ChangeSection
                    key={group.id}
                    {...group}
                    closed={closedGroups.has(group.id)}
                    selected={selected}
                    busy={busy}
                    onToggle={toggleGroup}
                    onOpen={openFile}
                    onStage={(file) => void run(() => file.staged
                      ? api.gitUnstage(projectId, [file.path], sessionId ?? undefined)
                      : api.gitStage(projectId, [file.path], sessionId ?? undefined))}
                    onDiscard={(file) => setConfirmRequest({
                      title: "Discard file changes?",
                      description: `All uncommitted changes in ${file.path} will be permanently discarded.`,
                      confirmLabel: "Discard changes",
                      action: () => api.gitDiscard(projectId, [file.path], sessionId ?? undefined),
                    })}
                  />
                ))}
              </div>
            </section>
            <section className="git-detail-pane" aria-label="Change details">
              {selected && (
                <div className="git-mobile-detail-head">
                  <button className="small-btn" onClick={() => setMobileDetail(false)}><Icon.back /> Changes</button>
                  <span className="mono" title={selected.path}>{selected.path}</span>
                </div>
              )}
              {!selected ? (
                <EmptyState
                  title={all.length === 0 ? "Working tree clean" : "Select a file to review"}
                  description={all.length === 0 ? "Local edits will appear here as soon as they are detected." : "Choose a file from the change list to inspect its diff."}
                />
              ) : (
                <>
                  <div className="git-detail-title">
                    <div>
                      <strong title={selected.path}>{selected.path}</strong>
                      <span className="muted">{selected.staged ? "Staged changes" : "Working tree changes"}</span>
                    </div>
                    <span className="header-spacer" />
                    {(addCount + delCount > 0) && <span className="diff-stat"><span>+{addCount}</span><span>−{delCount}</span></span>}
                  </div>
                  <DiffPrefsToolbar />
                  {diffLoading ? <DiffSkeleton /> : diffError ? (
                    <div className="source-inline-status error" role="alert">
                      <span>{diffError}</span>
                      <button className="small-btn" onClick={() => setDiffRetry((value) => value + 1)}>Retry</button>
                    </div>
                  ) : prefs.layout === "split" ? (
                    <DiffContent diff={diff} path={selected.path} split wrap={prefs.wrap} />
                  ) : (
                    <div className="copy-wrap">
                      <pre className={`git-diff git-diff-page${prefs.wrap ? " wrap" : ""}`}>
                        {hunks.length === 0 && diff.split("\n").map((line, index) => (
                          <div key={index} className="git-diff-line"><span className="git-diff-ln">{index + 1}</span><DiffCode line={line} path={selected.path} /></div>
                        ))}
                        {hunks.map((hunk, index) => (
                          <HunkBlock key={index} hunk={hunk} path={selected.path} onComment={() => {
                            setDraft({ digest: hunkDigest(hunk), line: hunk.startNew });
                            setDraftText("");
                          }} />
                        ))}
                      </pre>
                      <CopyButton text={diff} />
                    </div>
                  )}
                  {draft && (
                    <div className="review-draft">
                      <textarea autoFocus rows={3} placeholder={`Review note near line ${draft.line}…`} value={draftText} onChange={(event) => setDraftText(event.target.value)} />
                      <div className="commit-row">
                        <button className="small-btn" onClick={() => setDraft(null)}>Cancel</button>
                        <button className="primary-btn" disabled={!draftText.trim()} onClick={() => {
                          persistComments([...comments, {
                            id: `rc_${Date.now().toString(36)}`,
                            path: selected.path,
                            digest: draft.digest,
                            line: draft.line,
                            text: draftText.trim(),
                            createdAt: Date.now(),
                          }]);
                          setDraft(null);
                        }}>Add note</button>
                      </div>
                    </div>
                  )}
                  {fileComments.length > 0 && (
                    <div className="review-list">
                      <div className="stat-label">Review notes ({fileComments.length})</div>
                      {fileComments.map((comment) => {
                        const anchorState = commentState(comment, hunks);
                        return (
                          <div key={comment.id} className={`review-note${anchorState === "outdated" ? " outdated" : ""}`}>
                            <div className="review-note-head">
                              <span className="mono">L{comment.line}</span>
                              {anchorState === "outdated" && <span className="tag">Outdated</span>}
                              <span className="header-spacer" />
                              <button className="small-btn icon-only" title="Remove review note" aria-label="Remove review note" onClick={() => persistComments(comments.filter((item) => item.id !== comment.id))}><Icon.close /></button>
                            </div>
                            <div className="review-note-text">{comment.text}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>

          {status && status.staged.length > 0 && (
            <section className={`git-commit-composer${mobileDetail ? " detail-open" : ""}`} aria-label="Commit staged changes">
              <div className="git-commit-heading">
                <strong>Commit {status.staged.length} staged {status.staged.length === 1 ? "file" : "files"}</strong>
                <span className="muted">Changes are committed to <span className="mono">{status.branch || "HEAD"}</span></span>
              </div>
              <textarea className="commit-msg" rows={2} placeholder="Commit message…" value={commitMsg} onChange={(event) => setCommitMsg(event.target.value)} />
              <div className="commit-row">
                <button className="small-btn" disabled={generating || busy} onClick={() => {
                  setGenerating(true);
                  void api.gitCommitMessage(projectId, sessionId ?? undefined)
                    .then((result) => { if (result.message) setCommitMsg(result.message); })
                    .finally(() => setGenerating(false));
                }}>{generating ? "Generating…" : "✦ Generate"}</button>
                <button className="primary-btn" disabled={!commitMsg.trim() || busy} onClick={() => void run(async () => {
                  await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined);
                  setCommitMsg("");
                  setSelected(null);
                  setMobileDetail(false);
                })}>{busy ? "Committing…" : "Commit"}</button>
              </div>
            </section>
          )}
        </>
      )}

      {tab === "log" && (
        <div className={`git-master-detail git-log-layout ${mobileDetail ? "detail-open" : ""}`}>
          <section className="git-master-pane">
            <div className="source-search">
              <Icon.search />
              <input value={graphQuery} placeholder="Search commits, authors, or refs" aria-label="Search commit log" onChange={(event) => setGraphQuery(event.target.value)} />
              {graphQuery && <button className="source-search-clear" aria-label="Clear search" onClick={() => setGraphQuery("")}>×</button>}
            </div>
            <div className="git-ref-chips" aria-label="Filter by branch">
              <button className={!graphRef ? "active" : ""} aria-pressed={!graphRef} onClick={() => setGraphRef("")}>All branches</button>
              {branchChips.map((ref) => <button key={ref} className={graphRef === ref ? "active" : ""} aria-pressed={graphRef === ref} onClick={() => setGraphRef(ref)}>{ref}</button>)}
            </div>
            <div className="git-graph">
              {!loadError && visibleGraph.length === 0 && <div className="git-filter-empty">No commits match this filter.</div>}
              {visibleGraph.map(({ commit, row }) => (
                <button key={commit.sha} className={`git-graph-row ${commitSel === commit.sha ? "selected" : ""}`} aria-current={commitSel === commit.sha ? "true" : undefined} onClick={() => {
                  setCommitSel(commit.sha);
                  setSelected(null);
                  setMobileDetail(true);
                }}>
                  {row && <GraphSvg row={row} />}
                  <span className="git-graph-copy">
                    <span className="git-graph-subject">{commit.subject}</span>
                    <span className="git-graph-meta">{commit.author} · {new Date(commit.date).toLocaleDateString()} · <span className="mono">{commit.shortSha}</span></span>
                  </span>
                  <span className="git-graph-refs">
                    {commit.refs.slice(0, 2).map((ref) => <span key={ref} className={`graph-ref${ref.startsWith("tag: ") ? " tag" : ""}`}>{ref.replace(/^tag: /, "⌂ ")}</span>)}
                  </span>
                </button>
              ))}
            </div>
            {!graphDone && graph.length > 0 && <button className="small-btn git-load-more" disabled={graphLoading} onClick={() => void loadMoreGraph()}>{graphLoading ? "Loading older commits…" : "Load older commits"}</button>}
          </section>
          <section className="git-detail-pane">
            {commitSel && (
              <div className="git-mobile-detail-head">
                <button className="small-btn" onClick={() => setMobileDetail(false)}><Icon.back /> Log</button>
                <span className="mono">{selectedCommit?.shortSha ?? commitSel.slice(0, 7)}</span>
              </div>
            )}
            {!commitSel ? <EmptyState title="Select a commit" description="Choose a commit to inspect its complete patch." /> : (
              <>
                <div className="git-commit-detail-head">
                  <span className="git-sha">{selectedCommit?.shortSha ?? commitSel.slice(0, 7)}</span>
                  <strong>{selectedCommit?.subject}</strong>
                  {selectedCommit && <span className="muted">{selectedCommit.author} · {new Date(selectedCommit.date).toLocaleString()}</span>}
                </div>
                <DiffPrefsToolbar />
                {commitDiffLoading ? <DiffSkeleton /> : commitDiffError ? (
                  <div className="source-inline-status error" role="alert">
                    <span>{commitDiffError}</span>
                    <button className="small-btn" onClick={() => setCommitDiffRetry((value) => value + 1)}>Retry</button>
                  </div>
                ) : <DiffContent diff={commitDiff} path={commitDiffPath} split={prefs.layout === "split"} wrap={prefs.wrap} />}
              </>
            )}
          </section>
        </div>
      )}

      {tab === "branches" && (
        <div className="git-resource-page">
          <div className="git-resource-head">
            <div>
              <h2>Branches &amp; worktrees</h2>
              <p>Switch context or start an isolated workspace.</p>
            </div>
            <span className="header-spacer" />
            <button className="small-btn" onClick={() => {
              setShowBranchForm(true);
              setShowTreeForm(false);
              setShowPrForm(false);
            }}><Icon.branch /> New branch</button>
            <button className="small-btn" onClick={() => {
              setShowTreeForm(true);
              setShowBranchForm(false);
              setShowPrForm(false);
            }}><Icon.worktree /> New worktree</button>
            <button className="primary-btn" onClick={() => {
              setShowPrForm(true);
              setShowBranchForm(false);
              setShowTreeForm(false);
            }}><Icon.pullRequest /> Create PR</button>
          </div>
          <div className="git-resource-grid">
            <section className="git-resource-card">
              <div className="stat-label">Current branch</div>
              <div className="git-current-branch" aria-current="true"><Icon.branch /><span className="mono">{status?.branch || "detached HEAD"}</span><span className="tag">current</span></div>
              <div className="source-search git-branch-search">
                <Icon.search />
                <input value={branchQuery} placeholder="Search local and remote branches" aria-label="Search branches" onChange={(event) => setBranchQuery(event.target.value)} />
                {branchQuery && <button className="source-search-clear" aria-label="Clear branch search" onClick={() => setBranchQuery("")}>×</button>}
              </div>
              {(["Local", "Remote"] as const).map((label) => {
                const group: BranchGroup = label === "Remote" ? "remote" : "local";
                const remote = group === "remote";
                const normalized = branchQuery.trim().toLowerCase();
                const rows = branches.branches.filter((branch) =>
                  !branch.current
                  && Boolean(branch.remote) === remote
                  && (!remote || (branch.name !== branch.remote && !branch.name.endsWith("/HEAD")))
                  && (!normalized || branch.name.toLowerCase().includes(normalized)));
                const closed = closedBranchGroups.has(group);
                const shown = rows.slice(0, branchLimits[group]);
                return (
                  <div key={label} className="git-branch-section">
                    <button className="git-branch-section-head" aria-expanded={!closed} onClick={() => setClosedBranchGroups((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group); else next.add(group);
                      return next;
                    })}>
                      <span className={`git-folder-chevron${closed ? "" : " expanded"}`} aria-hidden="true"><Icon.chevronRight /></span>
                      <span>{label}</span>
                      <span className="git-count">{rows.length}</span>
                    </button>
                    {!closed && (
                      <div className="git-branch-list">
                        {!loadError && rows.length === 0 && <div className="git-group-empty">{normalized ? `No matching ${label.toLowerCase()} branches` : `No ${label.toLowerCase()} branches`}</div>}
                        {shown.map((branch) => (
                          <button key={branch.name} className="git-branch-row" disabled={busy} onClick={() => void run(() => api.gitCheckout(projectId, branch.name, sessionId ?? undefined))}>
                            <Icon.branch /><span className="mono git-branch-row-name" title={branch.name}>{branch.name}</span><span className="header-spacer" /><span className="muted">Checkout</span>
                          </button>
                        ))}
                        {shown.length < rows.length && (
                          <button className="small-btn git-branch-load-more" onClick={() => setBranchLimits((current) => ({ ...current, [group]: current[group] + 30 }))}>
                            Show 30 more <span className="muted">({rows.length - shown.length} remaining)</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
            <section className="git-resource-card">
              <div className="stat-label">Worktrees ({trees.length})</div>
              {!loadError && trees.length === 0 && <EmptyState title="No linked worktrees" description="New sessions currently run in the project root." />}
              <div className="git-worktree-list">
                {trees.map((tree) => (
                  <article key={tree.path} className="git-wt-card">
                    <div className="git-wt-copy">
                      <strong className="mono">{tree.branch ?? "detached HEAD"}</strong>
                      <span className="muted mono" title={tree.path}>{tree.path}</span>
                      <span className="muted mono">{tree.head.slice(0, 7)}</span>
                    </div>
                    <span className={`tag ${tree.isMain ? "green" : ""}`}>{tree.isMain ? "main" : "linked"}</span>
                    <button className="small-btn" title={`New session in ${tree.branch ?? "this worktree"}`} onClick={() => openWorktreeSessionDialog(projectId, tree.path)}><Icon.session /> Session</button>
                    {!tree.isMain && <button className="small-btn icon-only danger-btn" title="Remove worktree" aria-label={`Remove worktree ${tree.branch ?? tree.path}`} disabled={busy} onClick={() => setConfirmRequest({
                      title: "Remove worktree?",
                      description: `The linked worktree at ${tree.path} will be removed. Uncommitted work in it may be lost.`,
                      confirmLabel: "Remove worktree",
                      action: () => api.removeWorktree(projectId, tree.path, true),
                    })}><Icon.trash /></button>}
                  </article>
                ))}
              </div>
              <button className="small-btn git-new-session-btn" onClick={() => openWorktreeSessionDialog(projectId)}><Icon.session /> New worktree session</button>
            </section>
          </div>
        </div>
      )}

      {tab === "stashes" && (
        <div className="git-resource-page">
          <div className="git-resource-head">
            <div>
              <h2>Stashes</h2>
              <p>Temporarily set aside local changes without creating a commit.</p>
            </div>
          </div>
          <div className="git-stash-composer">
            <label htmlFor="stash-message">Stash current changes</label>
            <input id="stash-message" value={stashMessage} placeholder="Optional message" onChange={(event) => setStashMessage(event.target.value)} />
            <button className="primary-btn" disabled={busy || all.length === 0} onClick={() => void run(async () => {
              await api.gitStashPush(projectId, stashMessage.trim() || undefined, sessionId ?? undefined);
              setStashMessage("");
              setSelected(null);
            })}>Stash {all.length > 0 ? `${all.length} ${all.length === 1 ? "file" : "files"}` : "changes"}</button>
          </div>
          {!loadError && stashes.length === 0 ? <EmptyState title="No stashes" description="Saved work-in-progress changes will appear here." /> : stashes.length > 0 ? (
            <div className="git-stash-list">
              {stashes.map((stash) => (
                <article className="git-stash-card" key={stash.ref}>
                  <span className="git-stash-icon"><Icon.commit /></span>
                  <div>
                    <strong>{stash.message.replace(/^On [^:]+:\s*/, "") || "Stashed changes"}</strong>
                    <span className="muted"><span className="mono">{stash.ref}</span> · {new Date(stash.date).toLocaleString()}</span>
                  </div>
                  <span className="header-spacer" />
                  <button className="small-btn" disabled={busy} onClick={() => void run(() => api.gitStashApply(projectId, stash.ref, sessionId ?? undefined))}>Apply</button>
                  <button className="small-btn danger-btn" disabled={busy} onClick={() => setConfirmRequest({
                    title: "Drop stash?",
                    description: `${stash.ref} will be permanently deleted. This cannot be undone.`,
                    confirmLabel: "Drop stash",
                    action: () => api.gitStashDrop(projectId, stash.ref, sessionId ?? undefined),
                  })}>Drop</button>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DiffCode({ line, path }: { line: string; path?: string }) {
  if (!path) return <span>{line}</span>;
  return <span dangerouslySetInnerHTML={{ __html: highlight(line, langOf(path)) }} />;
}

function HunkBlock({ hunk, path, onComment }: { hunk: DiffHunk; path: string; onComment: () => void }) {
  let lineNumber = hunk.startNew;
  return (
    <>
      <div className="git-diff-line diff-hunk">
        <span className="git-diff-ln" />
        <span>{hunk.header}</span>
        <button className="hunk-comment-btn" title="Add review note for this hunk" aria-label="Add review note" onClick={onComment}>+</button>
      </div>
      {hunk.body.map((line, index) => {
        let className = "";
        let shown = "";
        if (line.startsWith("+")) { className = "diff-add"; shown = String(lineNumber++); }
        else if (line.startsWith("-")) className = "diff-del";
        else shown = String(lineNumber++);
        return <div key={index} className={`git-diff-line ${className}`}><span className="git-diff-ln">{shown}</span><DiffCode line={line} path={path} /></div>;
      })}
    </>
  );
}

function DiffPrefsToolbar() {
  const prefs = useGitPrefs();
  return (
    <div className="diff-prefs">
      <div className="diff-layout-toggle">
        <button className={prefs.layout === "unified" ? "active" : ""} aria-pressed={prefs.layout === "unified"} onClick={() => setGitPrefs({ layout: "unified" })}>Unified</button>
        <button className={prefs.layout === "split" ? "active" : ""} aria-pressed={prefs.layout === "split"} onClick={() => setGitPrefs({ layout: "split" })}>Split</button>
      </div>
      <label><input type="checkbox" checked={prefs.ignoreWhitespace} onChange={(event) => setGitPrefs({ ignoreWhitespace: event.target.checked })} /> Ignore whitespace</label>
      <label><input type="checkbox" checked={prefs.wrap} onChange={(event) => setGitPrefs({ wrap: event.target.checked })} /> Wrap lines</label>
    </div>
  );
}

function DiffContent({ diff, path, split, wrap }: { diff: string; path?: string; split: boolean; wrap: boolean }) {
  if (!diff) return <EmptyState title="No textual diff" description="This file may be binary, unchanged, or represented by metadata only." />;
  if (!split) {
    const lines = diff.split("\n");
    return (
      <div className="copy-wrap">
        <pre className={`git-diff git-diff-page${wrap ? " wrap" : ""}`}>
          {lines.map((line, index) => <DiffCode key={index} line={`${line}${index < lines.length - 1 ? "\n" : ""}`} {...(path ? { path } : {})} />)}
        </pre>
        <CopyButton text={diff} />
      </div>
    );
  }
  return (
    <div className="copy-wrap">
      <div className={`split-diff${wrap ? " wrap" : ""}`}>
        {splitDiffRows(diff).map((row, index) => (
          <div className={`split-diff-row ${row.kind}`} key={index}>
            <code className={row.left.startsWith("-") ? "diff-del" : ""}><DiffCode line={row.left} {...(path ? { path } : {})} /></code>
            <code className={row.right.startsWith("+") ? "diff-add" : ""}><DiffCode line={row.right} {...(path ? { path } : {})} /></code>
          </div>
        ))}
      </div>
      <CopyButton text={diff} />
    </div>
  );
}

function DiffSkeleton() {
  return (
    <div className="diff-skeleton" aria-label="Loading diff" aria-busy="true">
      <span /><span /><span /><span /><span />
    </div>
  );
}
