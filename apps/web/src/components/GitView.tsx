import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type GitBranches, type GitFileEntry, type GitGraphEntry, type GitStash, type GitStatus, type Worktree } from "../api.ts";
import { layoutGraph, type GraphRow } from "../git/graph.ts";
import { setGitPrefs, splitDiffRows, useGitPrefs } from "../gitPrefs.ts";
import { refreshGitStatus, useGitStatus } from "../gitStatusStore.ts";
import { highlight, langOf } from "../highlight.ts";
import { getLocale, tr } from "../i18n/index.ts";
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

const STATUS_LETTER: Record<string, { letter: string; cls: string }> = {
  added: { letter: "A", cls: "staged" },
  modified: { letter: "M", cls: "unstaged" },
  deleted: { letter: "D", cls: "unstaged" },
  renamed: { letter: "R", cls: "staged" },
  copied: { letter: "C", cls: "staged" },
  typechange: { letter: "T", cls: "unstaged" },
  untracked: { letter: "?", cls: "unstaged" },
  conflicted: { letter: "!", cls: "conflict" },
};

function statusLabel(status: string): string {
  switch (status) {
    case "added": return tr("gitview.added");
    case "deleted": return tr("gitview.deleted");
    case "renamed": return tr("gitview.renamed");
    case "copied": return tr("gitview.copied");
    case "typechange": return tr("gitview.typeChanged");
    case "untracked": return tr("gitview.untracked");
    case "conflicted": return tr("gitview.conflicted");
    default: return tr("gitview.modified");
  }
}

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
  const label = statusLabel(file.status);
  if (hit) return file.staged && file.status !== "conflicted" ? { ...hit, cls: "staged", label } : { ...hit, label };
  return { letter: "M", cls: file.staged ? "staged" : "unstaged", label: tr("gitview.modified") };
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
        <button className="small-btn icon-only" title={file.staged ? tr("gitview.unstage") : tr("gitview.stage")} aria-label={file.staged ? tr("gitview.unstageValue", { path: file.path }) : tr("gitview.stageValue", { path: file.path })} disabled={busy} onClick={onStage}>
          {file.staged ? <Icon.unstage /> : <Icon.stage />}
        </button>
        {onDiscard && (
          <button className="small-btn icon-only danger-btn" title={tr("gitview.discard")} aria-label={tr("gitview.discardValue", { path: file.path })} disabled={busy} onClick={onDiscard}>
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
      if (!nextStatus) throw new Error(tr("gitview.theGitServiceDidNotRespond"));
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
      setLoadError(friendlyError(tr("gitview.couldntLoadSourceControl"), cause));
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
        if (active) setDiffError(friendlyError(tr("gitview.couldntLoadTheFileDiff"), cause));
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
        if (active) setCommitDiffError(friendlyError(tr("gitview.couldntLoadTheCommitDiff"), cause));
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
      setUiError(friendlyError(tr("gitview.couldntUpdateTheRepository"), cause));
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
      setUiError(friendlyError(tr("gitview.couldntLoadOlderCommits"), cause));
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
  const { add: addCount, del: delCount } = diffStat(diff);

  const remoteLabel: Record<RemoteStep, { idle: string; busy: string }> = {
    fetch: { idle: tr("gitview.fetch"), busy: tr("gitview.fetching") },
    pull: { idle: tr("gitview.pull"), busy: tr("gitview.pulling") },
    push: { idle: tr("gitview.push"), busy: tr("gitview.pushing") },
  };

  if (!projectId) return <EmptyState title={tr("gitview.noProjectSelected")} description={tr("gitview.openAProjectToInspectItsGit")} />;

  if (loading && !status) {
    return (
      <div className="view-page git-page" aria-busy="true" aria-label={tr("gitview.loadingSourceControl")}>
        <div className="source-skeleton skeleton-title" />
        <div className="source-skeleton skeleton-tabs" />
        <div className="source-skeleton skeleton-panel" />
      </div>
    );
  }

  if (loadError && !status) {
    return <EmptyState title={tr("gitview.sourceControlUnavailable")} description={loadError} actionLabel={tr("common.retry")} onAction={() => void refresh(true)} />;
  }

  if (status?.isRepo === false) {
    return (
      <div className="view-page git-page">
        <EmptyState
          title={tr("gitview.thisFolderIsntAGitRepository")}
          description={tr("gitview.initializeGitInThisProject")}
          actionLabel={tr("gitview.checkAgain")}
          onAction={() => void refresh(true)}
        />
      </div>
    );
  }

  const changeGroups = [
    { id: "merge", title: tr("gitview.mergeChanges"), files: status?.conflicted ?? [] },
    { id: "staged", title: tr("gitview.stagedChanges"), files: status?.staged ?? [] },
    { id: "changes", title: tr("gitview.tabChanges"), files: status?.unstaged ?? [] },
    { id: "untracked", title: tr("gitview.untracked"), files: status?.untracked ?? [] },
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
          <h1 className="view-title">{tr("gitview.sourceControl")}</h1>
          <span className="source-branch"><Icon.branch /> <span className="mono">{status?.branch || tr("gitview.detachedHead")}</span></span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="git-ahead-behind">
              {status.ahead > 0 && <span className="ahead">↑ {status.ahead}</span>}
              {status.behind > 0 && <span className="behind">↓ {status.behind}</span>}
            </span>
          )}
        </div>
        <div className="source-remote-actions" aria-label={tr("gitview.remoteRepositoryActions")}>
          {(["fetch", "pull", "push"] as const).map((step) => (
            <button key={step} className="small-btn source-action-btn" disabled={busyRemote !== null || busy} onClick={() => void runRemote(step)}>
              {step === "fetch" ? <Icon.fetch /> : step === "pull" ? <Icon.pull /> : <Icon.push />}
              <span>{busyRemote === step ? remoteLabel[step].busy : remoteLabel[step].idle}</span>
            </button>
          ))}
          <button className="small-btn icon-only" title={tr("gitview.refreshSourceControl")} aria-label={tr("gitview.refreshSourceControl")} disabled={busy || busyRemote !== null} onClick={() => void refresh()}>
            <Icon.refresh />
          </button>
        </div>
      </header>

      {remoteStatus && (
        <div className={`source-inline-status ${remoteStatus.error ? "error" : "success"}`} role={remoteStatus.error ? "alert" : "status"}>
          {remoteStatus.error
            ? tr("gitview.stepFailedValue", { step: remoteLabel[remoteStatus.step].idle, error: remoteStatus.error })
            : tr("gitview.stepCompletedValue", { step: remoteLabel[remoteStatus.step].idle })}
        </div>
      )}

      {loadError && status && (
        <div className="source-inline-status error" role="alert">
          <span>{loadError}</span>
          <button className="small-btn" disabled={loading} onClick={() => void refresh(true)}>{tr("common.retry")}</button>
        </div>
      )}

      {confirmRequest && (
        <Dialog title={confirmRequest.title} onClose={() => setConfirmRequest(null)} initialFocus=".danger-btn">
          <div className="source-confirm-dialog">
            <h2>{confirmRequest.title}</h2>
            <p>{confirmRequest.description}</p>
            <div className="source-confirm-dialog-actions">
              <button className="small-btn" onClick={() => setConfirmRequest(null)}>{tr("common.cancel")}</button>
              <button className="primary-btn danger-btn" disabled={busy} onClick={() => {
                const request = confirmRequest;
                setConfirmRequest(null);
                void run(request.action);
              }}>{confirmRequest.confirmLabel}</button>
            </div>
          </div>
        </Dialog>
      )}

      <nav className="source-tabs" aria-label={tr("gitview.sourceControlViews")}>
        {([
          ["changes", `${tr("gitview.tabChanges")}${all.length ? ` ${all.length}` : ""}`],
          ["log", tr("gitview.tabLog")],
          ["branches", `${tr("gitview.tabBranches")} ${branches.branches.length}`],
          ["stashes", `${tr("gitview.tabStashes")} ${stashes.length}`],
        ] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => selectTab(id)}>{label}</button>
        ))}
      </nav>

      {showBranchForm && (
        <div className="source-inline-form">
          <label htmlFor="git-new-branch">{tr("gitview.createABranch")}</label>
          <input id="git-new-branch" className="mono" value={newBranch} placeholder={tr("gitview.branchNamePlaceholder")} onChange={(event) => setNewBranch(event.target.value)} />
          <button className="primary-btn" disabled={busy || !newBranch.trim()} onClick={() => void run(async () => {
            await api.gitBranch(projectId, newBranch.trim(), undefined, sessionId ?? undefined);
            setNewBranch("");
            setShowBranchForm(false);
            setTab("branches");
          })}>{tr("gitview.createBranch")}</button>
          <button className="small-btn" onClick={() => setShowBranchForm(false)}>{tr("common.cancel")}</button>
        </div>
      )}
      {showTreeForm && (
        <div className="source-inline-form">
          <label htmlFor="git-new-worktree">{tr("gitview.createAWorktree")}</label>
          <input id="git-new-worktree" className="mono" value={newTree} placeholder={tr("gitview.branchForTheWorktree")} onChange={(event) => setNewTree(event.target.value)} />
          <button className="primary-btn" disabled={busy || !newTree.trim()} onClick={() => void run(async () => {
            await api.createWorktree(projectId, newTree.trim());
            setNewTree("");
            setShowTreeForm(false);
            setTab("branches");
          })}>{tr("gitview.createWorktree")}</button>
          <button className="small-btn" onClick={() => setShowTreeForm(false)}>{tr("common.cancel")}</button>
        </div>
      )}
      {showPrForm && <PrCreatePanel projectId={projectId} sessionId={sessionId} onClose={() => setShowPrForm(false)} />}

      {tab === "changes" && (
        <div className="git-changes-layout">
          <div className={`git-master-detail ${mobileDetail ? "detail-open" : ""}`}>
            <section className="git-master-pane" aria-label={tr("gitview.changedFiles")}>
              <div className="git-pane-toolbar">
                <div>
                  <strong>{tr("gitview.workingTree")}</strong>
                  <span className="muted">{all.length === 0 ? tr("gitview.clean") : all.length === 1 ? tr("gitview.oneChangedFile") : tr("gitview.changedFilesValue", { count: all.length })}</span>
                </div>
                <span className="header-spacer" />
                {(status?.unstaged.length || status?.untracked.length || status?.conflicted.length) ? (
                  <button className="small-btn" disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "stage", sessionId ?? undefined))}>
                    <Icon.stage /> {tr("gitview.stageAll")}
                  </button>
                ) : null}
                {status && status.staged.length > 0 && (
                  <button className="small-btn icon-only" title={tr("gitview.unstageAll")} aria-label={tr("gitview.unstageAll")} disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "unstage", sessionId ?? undefined))}>
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
                      title: tr("gitview.discardFileChanges"),
                      description: tr("gitview.allUncommittedChangesInValue", { path: file.path }),
                      confirmLabel: tr("common.discardChanges"),
                      action: () => api.gitDiscard(projectId, [file.path], sessionId ?? undefined),
                    })}
                  />
                ))}
              </div>
            </section>
            <section className="git-detail-pane" aria-label={tr("gitview.changeDetails")}>
              {selected && (
                <div className="git-mobile-detail-head">
                  <button className="small-btn" onClick={() => setMobileDetail(false)}><Icon.back /> {tr("gitview.tabChanges")}</button>
                  <span className="mono" title={selected.path}>{selected.path}</span>
                </div>
              )}
              {!selected ? (
                <EmptyState
                  title={all.length === 0 ? tr("gitview.workingTreeClean") : tr("gitview.selectAFileToReview")}
                  description={all.length === 0 ? tr("gitview.localEditsWillAppearHere") : tr("gitview.chooseAFileFromTheChangeList")}
                />
              ) : (
                <>
                  <div className="git-detail-title">
                    <div>
                      <strong title={selected.path}>{selected.path}</strong>
                      <span className="muted">{selected.staged ? tr("gitview.stagedChangesLower") : tr("gitview.workingTreeChanges")}</span>
                    </div>
                    <span className="header-spacer" />
                    {(addCount + delCount > 0) && <span className="diff-stat"><span>+{addCount}</span><span>−{delCount}</span></span>}
                  </div>
                  <DiffPrefsToolbar />
                  {diffLoading ? <DiffSkeleton /> : diffError ? (
                    <div className="source-inline-status error" role="alert">
                      <span>{diffError}</span>
                      <button className="small-btn" onClick={() => setDiffRetry((value) => value + 1)}>{tr("common.retry")}</button>
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
                      <textarea autoFocus rows={3} placeholder={tr("gitview.reviewNoteNearLineValue", { line: draft.line })} value={draftText} onChange={(event) => setDraftText(event.target.value)} />
                      <div className="commit-row">
                        <button className="small-btn" onClick={() => setDraft(null)}>{tr("common.cancel")}</button>
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
                        }}>{tr("gitview.addNote")}</button>
                      </div>
                    </div>
                  )}
                  {fileComments.length > 0 && (
                    <div className="review-list">
                      <div className="stat-label">{tr("gitview.reviewNotesValue", { count: fileComments.length })}</div>
                      {fileComments.map((comment) => {
                        const anchorState = commentState(comment, hunks);
                        return (
                          <div key={comment.id} className={`review-note${anchorState === "outdated" ? " outdated" : ""}`}>
                            <div className="review-note-head">
                              <span className="mono">L{comment.line}</span>
                              {anchorState === "outdated" && <span className="tag">{tr("gitview.outdated")}</span>}
                              <span className="header-spacer" />
                              <button className="small-btn icon-only" title={tr("gitview.removeReviewNote")} aria-label={tr("gitview.removeReviewNote")} onClick={() => persistComments(comments.filter((item) => item.id !== comment.id))}><Icon.close /></button>
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

          {status && status.staged.length > 0 && !mobileDetail && (
            <section className="git-commit-composer" aria-label={tr("gitview.commitStagedChanges")}>
              <div className="git-commit-heading">
                <strong>{status.staged.length === 1 ? tr("gitview.commitOneStagedFile") : tr("gitview.commitStagedFilesValue", { count: status.staged.length })}</strong>
                <span className="muted">{tr("gitview.changesAreCommittedTo")} <span className="mono">{status.branch || "HEAD"}</span></span>
              </div>
              <textarea className="commit-msg" rows={2} placeholder={tr("gitview.commitMessage")} value={commitMsg} onChange={(event) => setCommitMsg(event.target.value)} />
              <div className="commit-row">
                <button className="small-btn" disabled={generating || busy} onClick={() => {
                  setGenerating(true);
                  void api.gitCommitMessage(projectId, sessionId ?? undefined)
                    .then((result) => { if (result.message) setCommitMsg(result.message); })
                    .finally(() => setGenerating(false));
                }}>{generating ? tr("gitview.generating") : tr("gitview.generate")}</button>
                <button className="primary-btn" disabled={!commitMsg.trim() || busy} onClick={() => void run(async () => {
                  await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined);
                  setCommitMsg("");
                  setSelected(null);
                  setMobileDetail(false);
                })}>{busy ? tr("gitview.committing") : tr("gitview.commit")}</button>
              </div>
            </section>
          )}
        </div>
      )}

      {tab === "log" && (
        <div className={`git-master-detail git-log-layout ${mobileDetail ? "detail-open" : ""}`}>
          <section className="git-master-pane">
            <div className="source-search">
              <Icon.search />
              <input value={graphQuery} placeholder={tr("gitview.searchCommitsAuthorsOrRefs")} aria-label={tr("gitview.searchCommitLog")} onChange={(event) => setGraphQuery(event.target.value)} />
              {graphQuery && <button className="source-search-clear" aria-label={tr("gitview.clearSearch")} onClick={() => setGraphQuery("")}>×</button>}
            </div>
            <div className="git-ref-chips" aria-label={tr("gitview.filterByBranch")}>
              <button className={!graphRef ? "active" : ""} aria-pressed={!graphRef} onClick={() => setGraphRef("")}>{tr("gitview.allBranches")}</button>
              {branchChips.map((ref) => <button key={ref} className={graphRef === ref ? "active" : ""} aria-pressed={graphRef === ref} onClick={() => setGraphRef(ref)}>{ref}</button>)}
            </div>
            <div className="git-graph">
              {!loadError && visibleGraph.length === 0 && <div className="git-filter-empty">{tr("gitview.noCommitsMatchThisFilter")}</div>}
              {visibleGraph.map(({ commit, row }) => (
                <button key={commit.sha} className={`git-graph-row ${commitSel === commit.sha ? "selected" : ""}`} aria-current={commitSel === commit.sha ? "true" : undefined} onClick={() => {
                  setCommitSel(commit.sha);
                  setSelected(null);
                  setMobileDetail(true);
                }}>
                  {row && <GraphSvg row={row} />}
                  <span className="git-graph-copy">
                    <span className="git-graph-subject">{commit.subject}</span>
                    <span className="git-graph-meta">{commit.author} · {new Date(commit.date).toLocaleDateString(getLocale())} · <span className="mono">{commit.shortSha}</span></span>
                  </span>
                  <span className="git-graph-refs">
                    {commit.refs.slice(0, 2).map((ref) => <span key={ref} className={`graph-ref${ref.startsWith("tag: ") ? " tag" : ""}`}>{ref.replace(/^tag: /, "⌂ ")}</span>)}
                  </span>
                </button>
              ))}
            </div>
            {!graphDone && graph.length > 0 && <button className="small-btn git-load-more" disabled={graphLoading} onClick={() => void loadMoreGraph()}>{graphLoading ? tr("gitview.loadingOlderCommits") : tr("gitview.loadOlderCommits")}</button>}
          </section>
          <section className="git-detail-pane">
            {commitSel && (
              <div className="git-mobile-detail-head">
                <button className="small-btn" onClick={() => setMobileDetail(false)}><Icon.back /> {tr("gitview.tabLog")}</button>
                <span className="mono">{selectedCommit?.shortSha ?? commitSel.slice(0, 7)}</span>
              </div>
            )}
            {!commitSel ? <EmptyState title={tr("gitview.selectACommit")} description={tr("gitview.chooseACommitToInspect")} /> : (
              <>
                <div className="git-commit-detail-head">
                  <span className="git-sha">{selectedCommit?.shortSha ?? commitSel.slice(0, 7)}</span>
                  <strong>{selectedCommit?.subject}</strong>
                  {selectedCommit && <span className="muted">{selectedCommit.author} · {new Date(selectedCommit.date).toLocaleString(getLocale())}</span>}
                </div>
                <DiffPrefsToolbar />
                {commitDiffLoading ? <DiffSkeleton /> : commitDiffError ? (
                  <div className="source-inline-status error" role="alert">
                    <span>{commitDiffError}</span>
                    <button className="small-btn" onClick={() => setCommitDiffRetry((value) => value + 1)}>{tr("common.retry")}</button>
                  </div>
                ) : <DiffContent diff={commitDiff} split={prefs.layout === "split"} wrap={prefs.wrap} />}
              </>
            )}
          </section>
        </div>
      )}

      {tab === "branches" && (
        <div className="git-resource-page">
          <div className="git-resource-head">
            <div>
              <h2>{tr("gitview.branchesAmpWorktrees")}</h2>
              <p>{tr("gitview.switchContextOrStartAnIsolated")}</p>
            </div>
            <span className="header-spacer" />
            <button className="small-btn" onClick={() => {
              setShowBranchForm(true);
              setShowTreeForm(false);
              setShowPrForm(false);
            }}><Icon.branch /> {tr("gitview.newBranch")}</button>
            <button className="small-btn" onClick={() => {
              setShowTreeForm(true);
              setShowBranchForm(false);
              setShowPrForm(false);
            }}><Icon.worktree /> {tr("gitview.newWorktree")}</button>
            <button className="primary-btn" onClick={() => {
              setShowPrForm(true);
              setShowBranchForm(false);
              setShowTreeForm(false);
            }}><Icon.pullRequest /> {tr("gitview.createPr")}</button>
          </div>
          <div className="git-resource-grid">
            <section className="git-resource-card">
              <div className="stat-label">{tr("gitview.currentBranch")}</div>
              <div className="git-current-branch" aria-current="true"><Icon.branch /><span className="mono">{status?.branch || tr("gitview.detachedHead")}</span><span className="tag">{tr("gitview.current")}</span></div>
              <div className="source-search git-branch-search">
                <Icon.search />
                <input value={branchQuery} placeholder={tr("gitview.searchLocalAndRemoteBranches")} aria-label={tr("gitview.searchBranches")} onChange={(event) => setBranchQuery(event.target.value)} />
                {branchQuery && <button className="source-search-clear" aria-label={tr("gitview.clearBranchSearch")} onClick={() => setBranchQuery("")}>×</button>}
              </div>
              {(["local", "remote"] as const).map((group) => {
                const remote = group === "remote";
                const label = remote ? tr("gitview.remote") : tr("gitview.local");
                const normalized = branchQuery.trim().toLowerCase();
                const rows = branches.branches.filter((branch) =>
                  !branch.current
                  && Boolean(branch.remote) === remote
                  && (!remote || (branch.name !== branch.remote && !branch.name.endsWith("/HEAD")))
                  && (!normalized || branch.name.toLowerCase().includes(normalized)));
                const closed = closedBranchGroups.has(group);
                const shown = rows.slice(0, branchLimits[group]);
                const emptyText = remote
                  ? (normalized ? tr("gitview.noMatchingRemoteBranches") : tr("gitview.noRemoteBranches"))
                  : (normalized ? tr("gitview.noMatchingLocalBranches") : tr("gitview.noLocalBranches"));
                return (
                  <div key={group} className="git-branch-section">
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
                        {!loadError && rows.length === 0 && <div className="git-group-empty">{emptyText}</div>}
                        {shown.map((branch) => (
                          <button key={branch.name} className="git-branch-row" disabled={busy} onClick={() => void run(() => api.gitCheckout(projectId, branch.name, sessionId ?? undefined))}>
                            <Icon.branch /><span className="mono git-branch-row-name" title={branch.name}>{branch.name}</span><span className="header-spacer" /><span className="muted">{tr("gitview.checkout")}</span>
                          </button>
                        ))}
                        {shown.length < rows.length && (
                          <button className="small-btn git-branch-load-more" onClick={() => setBranchLimits((current) => ({ ...current, [group]: current[group] + 30 }))}>
                            {tr("gitview.showMoreValue", { count: 30 })} <span className="muted">{tr("gitview.remainingValue", { count: rows.length - shown.length })}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
            <section className="git-resource-card">
              <div className="stat-label">{tr("gitview.worktreesValue", { count: trees.length })}</div>
              {!loadError && trees.length === 0 && <EmptyState title={tr("gitview.noLinkedWorktrees")} description={tr("gitview.newSessionsCurrentlyRunInThe")} />}
              <div className="git-worktree-list">
                {trees.map((tree) => (
                  <article key={tree.path} className="git-wt-card">
                    <div className="git-wt-copy">
                      <strong className="mono">{tree.branch ?? tr("gitview.detachedHead")}</strong>
                      <span className="muted mono" title={tree.path}>{tree.path}</span>
                      <span className="muted mono">{tree.head.slice(0, 7)}</span>
                    </div>
                    <span className={`tag ${tree.isMain ? "green" : ""}`}>{tree.isMain ? tr("gitview.main") : tr("gitview.linked")}</span>
                    <button className="small-btn" title={tr("gitview.newSessionInValue", { branch: tree.branch ?? tr("gitview.thisWorktree") })} onClick={() => openWorktreeSessionDialog(projectId, tree.path)}><Icon.session /> {tr("gitview.session")}</button>
                    {!tree.isMain && <button className="small-btn icon-only danger-btn" title={tr("gitview.removeWorktree")} aria-label={tr("gitview.removeWorktreeValue", { branch: tree.branch ?? tree.path })} disabled={busy} onClick={() => setConfirmRequest({
                      title: tr("gitview.removeWorktreeQuestion"),
                      description: tr("gitview.theLinkedWorktreeAtValue", { path: tree.path }),
                      confirmLabel: tr("gitview.removeWorktree"),
                      action: () => api.removeWorktree(projectId, tree.path, true),
                    })}><Icon.trash /></button>}
                  </article>
                ))}
              </div>
              <button className="small-btn git-new-session-btn" onClick={() => openWorktreeSessionDialog(projectId)}><Icon.session /> {tr("gitview.newWorktreeSession")}</button>
            </section>
          </div>
        </div>
      )}

      {tab === "stashes" && (
        <div className="git-resource-page">
          <div className="git-resource-head">
            <div>
              <h2>{tr("gitview.tabStashes")}</h2>
              <p>{tr("gitview.temporarilySetAsideLocalChanges")}</p>
            </div>
          </div>
          <div className="git-stash-composer">
            <label htmlFor="stash-message">{tr("gitview.stashCurrentChanges")}</label>
            <input id="stash-message" value={stashMessage} placeholder={tr("gitview.optionalMessage")} onChange={(event) => setStashMessage(event.target.value)} />
            <button className="primary-btn" disabled={busy || all.length === 0} onClick={() => void run(async () => {
              await api.gitStashPush(projectId, stashMessage.trim() || undefined, sessionId ?? undefined);
              setStashMessage("");
              setSelected(null);
            })}>{all.length === 1 ? tr("gitview.stashOneFile") : all.length > 1 ? tr("gitview.stashFilesValue", { count: all.length }) : tr("gitview.stashChanges")}</button>
          </div>
          {!loadError && stashes.length === 0 ? <EmptyState title={tr("gitview.noStashes")} description={tr("gitview.savedWorkInProgressChanges")} /> : stashes.length > 0 ? (
            <div className="git-stash-list">
              {stashes.map((stash) => (
                <article className="git-stash-card" key={stash.ref}>
                  <span className="git-stash-icon"><Icon.commit /></span>
                  <div>
                    <strong>{stash.message.replace(/^On [^:]+:\s*/, "") || tr("gitview.stashedChanges")}</strong>
                    <span className="muted"><span className="mono">{stash.ref}</span> · {new Date(stash.date).toLocaleString(getLocale())}</span>
                  </div>
                  <span className="header-spacer" />
                  <button className="small-btn" disabled={busy} onClick={() => void run(() => api.gitStashApply(projectId, stash.ref, sessionId ?? undefined))}>{tr("common.apply")}</button>
                  <button className="small-btn danger-btn" disabled={busy} onClick={() => setConfirmRequest({
                    title: tr("gitview.dropStashQuestion"),
                    description: tr("gitview.stashWillBePermanentlyDeleted", { ref: stash.ref }),
                    confirmLabel: tr("gitview.dropStash"),
                    action: () => api.gitStashDrop(projectId, stash.ref, sessionId ?? undefined),
                  })}>{tr("gitview.drop")}</button>
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
        <button className="hunk-comment-btn" title={tr("gitview.addReviewNoteForThisHunk")} aria-label={tr("gitview.addReviewNote")} onClick={onComment}>+</button>
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
        <button className={prefs.layout === "unified" ? "active" : ""} aria-pressed={prefs.layout === "unified"} onClick={() => setGitPrefs({ layout: "unified" })}>{tr("gitview.unified")}</button>
        <button className={prefs.layout === "split" ? "active" : ""} aria-pressed={prefs.layout === "split"} onClick={() => setGitPrefs({ layout: "split" })}>{tr("gitview.split")}</button>
      </div>
      <label><input type="checkbox" checked={prefs.ignoreWhitespace} onChange={(event) => setGitPrefs({ ignoreWhitespace: event.target.checked })} /> {tr("gitview.ignoreWhitespace")}</label>
      <label><input type="checkbox" checked={prefs.wrap} onChange={(event) => setGitPrefs({ wrap: event.target.checked })} /> {tr("gitview.wrapLines")}</label>
    </div>
  );
}

interface DiffSyntaxSection {
  diff: string;
  path?: string;
}

/** Keep commit metadata unhighlighted and detect syntax independently for each file patch. */
export function diffSyntaxSections(diff: string, path?: string): DiffSyntaxSection[] {
  if (path) return [{ diff, path }];
  const firstFileHeader = diff.search(/^diff --git /m);
  if (firstFileHeader < 0) return [{ diff }];

  const sections: DiffSyntaxSection[] = [];
  const prelude = diff.slice(0, firstFileHeader);
  if (prelude) sections.push({ diff: prelude });
  for (const file of splitPrDiff(diff.slice(firstFileHeader))) {
    sections.push({ diff: file.diff, path: file.path });
  }
  return sections;
}

export function DiffContent({ diff, path, split, wrap }: { diff: string; path?: string; split: boolean; wrap: boolean }) {
  if (!diff) return <EmptyState title={tr("gitview.noTextualDiff")} description={tr("gitview.thisFileMayBeBinary")} />;
  const sections = diffSyntaxSections(diff, path);
  if (!split) {
    return (
      <div className="copy-wrap">
        {sections.map((section, sectionIndex) => {
          const lines = section.diff.split("\n");
          return (
            <pre
              className={`git-diff git-diff-page${wrap ? " wrap" : ""}`}
              data-diff-path={section.path}
              key={`${section.path ?? "metadata"}:${sectionIndex}`}
            >
              {lines.map((line, index) => (
                <DiffCode
                  key={index}
                  line={`${line}${index < lines.length - 1 ? "\n" : ""}`}
                  {...(section.path ? { path: section.path } : {})}
                />
              ))}
            </pre>
          );
        })}
        <CopyButton text={diff} />
      </div>
    );
  }
  return (
    <div className="copy-wrap">
      <div className={`split-diff${wrap ? " wrap" : ""}`}>
        {sections.map((section, sectionIndex) => (
          <div className="split-diff-section" data-diff-path={section.path} key={`${section.path ?? "metadata"}:${sectionIndex}`}>
            {splitDiffRows(section.diff).map((row, index) => (
              <div className={`split-diff-row ${row.kind}`} key={index}>
                <code className={row.left.startsWith("-") ? "diff-del" : ""}><DiffCode line={row.left} {...(section.path ? { path: section.path } : {})} /></code>
                <code className={row.right.startsWith("+") ? "diff-add" : ""}><DiffCode line={row.right} {...(section.path ? { path: section.path } : {})} /></code>
              </div>
            ))}
          </div>
        ))}
      </div>
      <CopyButton text={diff} />
    </div>
  );
}

function DiffSkeleton() {
  return (
    <div className="diff-skeleton" aria-label={tr("gitview.loadingDiff")} aria-busy="true">
      <span /><span /><span /><span /><span />
    </div>
  );
}
