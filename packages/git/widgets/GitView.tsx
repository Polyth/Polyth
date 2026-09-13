import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isManagedIsolationBranch } from "@polyth/contracts";
import { api, errorCodeOf, errorChangesOf, type GitBranches, type GitFileEntry, type GitGraphEntry, type GitStash, type GitStatus, type Worktree } from "@polyth/session/web-api";
import { layoutGraph, type GraphRow } from "./git/graph.ts";
import { setGitPrefs, splitDiffRows, useGitPrefs } from "./gitPrefs.ts";
import { refreshGitStatus, useGitStatus } from "./gitStatusStore.ts";
import { highlight, langOf } from "../../../apps/web/src/highlight.ts";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { openSession } from "../../../apps/web/src/init.ts";
import { splitPrDiff } from "./prDiff.ts";
import {
  commentState, hunkDigest, loadComments, saveComments, splitHunks,
  type DiffHunk, type ReviewComment,
} from "../../../apps/web/src/review/anchors.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { openWorktreeSessionDialog, setGitBranch, setGitDiffPath, setUiError, useStore } from "../../../apps/web/src/store.ts";
import { diffStat } from "../../../apps/web/src/utils.ts";
import { setPaneLastResource } from "../../../apps/web/src/workspace/panePrefs.ts";
import CopyButton from "../../../apps/web/src/components/CopyButton.tsx";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import type { WebPackageHost } from "@polyth/web-sdk";
import { summarizeUnifiedDiff, totalDiffStats, type DiffLineStats } from "./PendingChangesBar.tsx";
import {
  AddIcon,
  AssistIcon,
  BackIcon,
  BranchIcon,
  Button,
  Checkbox,
  CloseIcon,
  CombineIcon,
  DeleteIcon,
  Dialog,
  FetchIcon,
  // The namespaced `Icon` map from icons.tsx already owns that name here, so
  // the design-system glyph wrapper comes in aliased.
  Icon as UiIcon,
  IconButton,
  Menu,
  MoreIcon,
  type MenuEntry,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  RefreshIcon,
  SessionIcon,
  StageIcon,
  SyncIcon,
  Tabs,
  Textarea,
  TextInput,
  UndoIcon,
  WorktreeIcon,
} from "../../../apps/web/src/components/ui/index.ts";

type GitTab = "changes" | "log" | "branches" | "stashes";
type RemoteStep = "fetch" | "pull" | "push" | "sync";
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

function fileStatKey(file: GitFileEntry): string {
  return `${file.staged ? "s" : "u"}:${file.path}`;
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

function FileLineStats({ stats }: { stats: DiffLineStats }) {
  if (stats.additions === 0 && stats.deletions === 0) return null;
  return (
    <span
      className="git-file-linestat"
      aria-label={tr("pendingchangesbar.valueAdditionsValueDeletions", {
        additions: stats.additions,
        deletions: stats.deletions,
      })}
    >
      <span className="additions" aria-hidden="true">+{stats.additions}</span>
      <span className="deletions" aria-hidden="true">-{stats.deletions}</span>
    </span>
  );
}

function GitFileRow({ file, selected, busy, stats, onOpen, onStage, onDiscard }: {
  file: GitFileEntry;
  selected: boolean;
  busy: boolean;
  stats?: DiffLineStats;
  onOpen: () => void;
  onStage: () => void;
  onDiscard?: () => void;
}) {
  const { letter, cls, label } = fileLetter(file);
  return (
    <div className={`git-file-row ${selected ? "selected" : ""}`}>
      {onDiscard && (
        <IconButton
          icon={UndoIcon}
          size="sm"
          title={tr("gitview.revert")}
          label={tr("gitview.revertValue", { path: file.path })}
          disabled={busy}
          onClick={onDiscard}
        />
      )}
      <button type="button" className="git-file-main" aria-current={selected ? "true" : undefined} onClick={onOpen}>
        <span className={`git-file-letter ${cls}`} title={label} aria-label={label}>{letter}</span>
        <span className="git-file-path" title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
          {file.origPath ? <><span className="muted">{file.origPath} → </span>{file.path}</> : file.path}
        </span>
      </button>
      {stats && <FileLineStats stats={stats} />}
      <span className="git-file-actions">
        <IconButton
          icon={file.staged ? UndoIcon : AddIcon}
          size="sm"
          label={file.staged ? tr("gitview.unstageValue", { path: file.path }) : tr("gitview.stageValue", { path: file.path })}
          title={file.staged ? tr("gitview.unstage") : tr("gitview.stage")}
          disabled={busy}
          onClick={onStage}
        />
      </span>
    </div>
  );
}

function ChangeSection({ id, title, files, closed, selected, busy, fileStats, onToggle, onOpen, onStage, onDiscard }: {
  id: string;
  title: string;
  files: GitFileEntry[];
  closed: boolean;
  selected: { path: string; staged: boolean } | null;
  busy: boolean;
  fileStats: Record<string, DiffLineStats>;
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
              stats={fileStats[fileStatKey(file)]}
              onOpen={() => onOpen(file)}
              onStage={() => onStage(file)}
              {...(file.status !== "conflicted" ? { onDiscard: () => onDiscard(file) } : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type ConflictAgentTarget = "new-session" | "current-session";

/** Inline "resolve this conflict with an agent" affordance. Shown wherever the
 *  git surface knows the repo is conflicted — a diverged fast-forward pull or
 *  unresolved working-tree merge conflicts — and offers the handoff in the
 *  current session or a fresh one, seeded with the user's default prompt. */
function ConflictAgentBanner({
  hint, defaultTarget, hasCurrentSession, busy, message, failed, onResolve,
}: {
  hint: string;
  defaultTarget: ConflictAgentTarget;
  hasCurrentSession: boolean;
  busy: ConflictAgentTarget | null;
  message: string;
  failed: boolean;
  onResolve: (target: ConflictAgentTarget) => void;
}) {
  return (
    <div className="source-inline-status conflict-agent-bar" role="group" aria-label={tr("gitview.resolveConflictWithAgent")}>
      <div className="conflict-agent-copy">
        <strong>{tr("gitview.resolveConflictWithAgent")}</strong>
        <span className="muted">{hint}</span>
      </div>
      <div className="conflict-agent-actions">
        <Button
          size="sm"
          variant={defaultTarget === "current-session" ? "primary" : "ghost"}
          iconStart={AssistIcon}
          busy={busy === "current-session"}
          disabled={busy !== null || !hasCurrentSession}
          onClick={() => onResolve("current-session")}
        >
          {tr("gitview.resolveInThisSession")}
        </Button>
        <Button
          size="sm"
          variant={defaultTarget === "new-session" ? "primary" : "ghost"}
          iconStart={AssistIcon}
          busy={busy === "new-session"}
          disabled={busy !== null}
          onClick={() => onResolve("new-session")}
        >
          {tr("gitview.resolveInNewSession")}
        </Button>
      </div>
      {message && (
        <div className={failed ? "form-error" : "form-success"} role={failed ? "alert" : "status"}>
          {message}
        </div>
      )}
    </div>
  );
}

export default function GitView({ host }: { host?: WebPackageHost } = {}) {
  const Slot = host?.ui.Slot;
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const settings = useStore((state) => state.settings);
  const diffPath = useStore((state) => state.gitDiffPath);
  // This project's worktree topology revision. It moves when a worktree is
  // created or removed anywhere — here, by an agent, by a shell — and nothing
  // else moves it, so another project's churn never refetches this one.
  const worktreeTopology = useStore((state) => (state.activeProjectId && state.worktreeTopology[state.activeProjectId]) || 0);
  const status = useGitStatus(projectId, true, sessionId);
  const prefs = useGitPrefs();
  const [tab, setTab] = useState<GitTab>("changes");
  const [branches, setBranches] = useState<GitBranches>({ current: null, branches: [] });
  const [trees, setTrees] = useState<Worktree[]>([]);
  const visibleTrees = trees.filter((tree) => !tree.branch?.startsWith("polyth/isolate/"));
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
  const [selectedChangeProvider, setSelectedChangeProvider] = useState<string | null>(null);
  useEffect(() => { setSelectedChangeProvider(null); }, [projectId]);
  const [busy, setBusy] = useState(false);
  const [busyRemote, setBusyRemote] = useState<RemoteStep | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<{ step: RemoteStep; error?: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [conflictAgentBusy, setConflictAgentBusy] = useState<ConflictAgentTarget | null>(null);
  const [conflictAgentMsg, setConflictAgentMsg] = useState("");
  const [conflictAgentFailed, setConflictAgentFailed] = useState(false);
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
  const [fileStats, setFileStats] = useState<Record<string, DiffLineStats>>({});
  // Which worktree row is mid-action, as `<path>:<step>`. Keyed by path so one
  // busy checkout never freezes the others' controls.
  const [treeBusy, setTreeBusy] = useState<string | null>(null);

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
        // Ahead/behind/dirty per checkout is what makes the per-worktree
        // push/merge controls honest rather than decorative.
        api.listWorktrees(projectId, { status: true }),
        api.gitGraph(projectId, GRAPH_PAGE, 0, sessionId ?? undefined),
        api.gitStashes(projectId, sessionId ?? undefined),
      ]);
      setBranches({ ...nextBranches, branches: nextBranches.branches.filter((branch) => !isManagedIsolationBranch(branch.remote ? branch.name.slice(branch.remote.length + 1) : branch.name)) });
      setTrees(nextTrees.filter((tree) => !isManagedIsolationBranch(tree.branch)));
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

  // A topology change re-reads the lists but must not disturb the pane: the
  // open diff, the commit selection and the mobile detail view all survive,
  // because a worktree appearing elsewhere is not a reason to lose your place.
  const topologyHydrated = useRef(false);
  useEffect(() => {
    if (!topologyHydrated.current) { topologyHydrated.current = true; return; }
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeTopology]);

  useEffect(() => {
    setComments(projectId ? loadComments(projectId) : []);
  }, [projectId]);

  useEffect(() => {
    if (!diffPath || !status) return;
    const file = [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].find((candidate) => candidate.path === diffPath);
    // The resource is a navigation request, not a standing selection. Keeping
    // it set makes every polled status refresh reopen the old file after the
    // user returns to the change list.
    setGitDiffPath(null);
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

  // Only re-summarize once the set of changed paths actually shifts — the
  // status poll below replaces `status` every 2.5s even when nothing changed.
  const changeKey = status
    ? [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked]
        .map(fileStatKey).sort().join("\0")
    : "";

  useEffect(() => {
    if (!projectId || !status || status.isRepo === false || !changeKey) {
      setFileStats({});
      return;
    }
    const files = [...status.conflicted, ...status.staged, ...status.unstaged, ...status.untracked];
    let cancelled = false;
    void Promise.all(files.map(async (file) => {
      try {
        const result = await api.gitDiff(projectId, file.path, file.staged, false, sessionId ?? undefined);
        return [fileStatKey(file), summarizeUnifiedDiff(result.diff)] as const;
      } catch {
        return [fileStatKey(file), null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next: Record<string, DiffLineStats> = {};
      for (const [key, stats] of entries) if (stats) next[key] = stats;
      setFileStats(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by changeKey, not the polled status object
  }, [projectId, sessionId, changeKey]);

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

  // One button: commit what's staged (when a message is present), then sync via
  // the server-owned fetch/integrate/publish flow.
  const syncRepository = async () => {
    if (!projectId) return;
    if (commitMsg.trim() && (status?.staged.length ?? 0) > 0) {
      await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined);
      setCommitMsg("");
      setSelected(null);
      setMobileDetail(false);
    }
    await api.gitSync(projectId, "origin", sessionId ?? undefined);
  };

  const runRemote = async (step: RemoteStep) => {
    if (!projectId) return;
    setBusyRemote(step);
    setRemoteStatus(null);
    try {
      if (step === "sync") {
        await syncRepository();
      } else {
        const action = step === "fetch" ? api.gitFetch : step === "pull" ? api.gitPull : api.gitPush;
        await action(projectId, "origin", sessionId ?? undefined);
      }
      setRemoteStatus({ step });
      await refresh();
    } catch (cause) {
      setRemoteStatus({ step, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusyRemote(null);
    }
  };

  // Remote steps aimed at one linked checkout. The path is a selector, not a
  // trusted root: the server matches it against this project's own worktree
  // list before Git touches anything.
  const runTreeRemote = async (tree: Worktree, step: RemoteStep) => {
    if (!projectId || treeBusy) return;
    setTreeBusy(`${tree.path}:${step}`);
    try {
      const scope = { worktreePath: tree.path };
      if (step === "fetch") await api.gitFetch(projectId, "origin", undefined, scope);
      else if (step === "pull") await api.gitPull(projectId, "origin", undefined, scope);
      else if (step === "push") await api.gitPush(projectId, "origin", undefined, scope);
      else await api.gitSync(projectId, "origin", undefined, scope);
      await refresh();
    } catch (cause) {
      setUiError(friendlyError(tr("gitview.worktreeActionFailed"), cause));
    } finally {
      setTreeBusy(null);
    }
  };

  // Merge a linked checkout's branch into the branch this project has checked
  // out. A conflict is an expected outcome, not an error: Git stops with the
  // tree conflicted, so hand the user to the Changes tab where the conflict
  // tools already live instead of silently aborting their merge.
  const mergeTree = async (tree: Worktree) => {
    if (!projectId || !tree.branch || treeBusy) return;
    setTreeBusy(`${tree.path}:merge`);
    try {
      const result = await api.gitMerge(projectId, tree.branch);
      await refresh();
      if (!result.ok) {
        setTab("changes");
        setUiError(tr("gitview.mergeStoppedOnConflicts", { count: result.conflicted.length }));
      }
    } catch (cause) {
      setUiError(friendlyError(tr("gitview.worktreeActionFailed"), cause));
    } finally {
      setTreeBusy(null);
    }
  };

  // Removal keeps its two-step shape: the first refusal carries the dirty
  // count, and only an explicit second confirmation destroys uncommitted work.
  const requestRemoveTree = (tree: Worktree) => {
    if (!projectId) return;
    setConfirmRequest({
      title: tr("gitview.removeWorktreeQuestion"),
      description: tr("gitview.theLinkedWorktreeAtValue", { path: tree.path }),
      confirmLabel: tr("gitview.removeWorktree"),
      action: async () => {
        const finish = async (force?: boolean) => {
          const result = await api.removeWorktree(projectId, tree.path, true, force);
          if (result.metadataCleanupFailed || result.branchCleanupFailed) {
            setUiError(tr("gitview.couldntCleanUpAfterRemovingTheWorktree"));
          }
        };
        try {
          await finish();
        } catch (err) {
          if (errorCodeOf(err) !== "worktree-dirty") throw err;
          const changes = errorChangesOf(err);
          setConfirmRequest({
            title: tr("gitview.removeWorktreeQuestion"),
            description: changes > 0
              ? tr("gitview.destroyDirtyWorktreeValue", { count: changes })
              : tr("gitview.destroyDirtyWorktree"),
            confirmLabel: tr("gitview.removeWorktree"),
            action: () => finish(true),
          });
        }
      },
    });
  };

  const startConflictAgent = async (target: ConflictAgentTarget, problem?: string) => {
    if (conflictAgentBusy || !projectId) return;
    if (target === "current-session" && !sessionId) {
      setConflictAgentFailed(true);
      setConflictAgentMsg(tr("pullrequestview.conflictAgentNeedsCurrentSession"));
      return;
    }
    setConflictAgentBusy(target);
    setConflictAgentMsg("");
    setConflictAgentFailed(false);
    try {
      const result = await api.gitResolveConflictAgent({
        projectId,
        target,
        prompt: settings.conflictAgentPrompt,
        ...(problem?.trim() ? { problem: problem.trim() } : {}),
        ...(target === "current-session" && sessionId ? { sessionId } : {}),
      });
      if (!result.ok) {
        setConflictAgentFailed(true);
        setConflictAgentMsg(result.reason);
        return;
      }
      // The server already created the session and admitted the prompt. State
      // that before navigating: a failure to open the chat must not be
      // reported as a failure to start the conflict resolution.
      setConflictAgentMsg(tr("gitview.conflictAgentStarted"));
      if (target === "new-session" || result.data.sessionId !== sessionId) {
        try {
          await openSession(result.data.sessionId);
        } catch (cause) {
          setUiError(friendlyError(tr("common.error"), cause));
        }
      }
    } catch (cause) {
      setConflictAgentFailed(true);
      setConflictAgentMsg(friendlyError(tr("pullrequestview.conflictAgentFailed"), cause));
    } finally {
      setConflictAgentBusy(null);
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
  const totalFileStats = totalDiffStats(Object.values(fileStats));

  const remoteLabel: Record<RemoteStep, { idle: string; busy: string }> = {
    fetch: { idle: tr("gitview.fetch"), busy: tr("gitview.fetching") },
    pull: { idle: tr("gitview.pull"), busy: tr("gitview.pulling") },
    push: { idle: tr("gitview.push"), busy: tr("gitview.pushing") },
    sync: { idle: tr("gitview.syncRepository"), busy: tr("gitview.syncRepository") },
  };

  if (!projectId) return <EmptyState title={tr("gitview.noProjectSelected")} description={tr("gitview.openAProjectToInspectItsGit")} />;

  if (loading && !status) {
    return (
      <div className="git-page" aria-busy="true" aria-label={tr("gitview.loadingSourceControl")}>
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
      <div className="git-page">
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

  const commitStaged = async () => {
    await api.gitCommit(projectId, commitMsg.trim(), sessionId ?? undefined);
    setCommitMsg("");
    setSelected(null);
    setMobileDetail(false);
  };

  return (
    <div className="git-page">
      <header className="source-control-head">
        <div className="source-control-title">
          {/* Title + close come from the shared ContextRail / ModuleView header. */}
          <span className="source-branch"><Icon.branch /> <span className="mono">{status?.branch || tr("gitview.detachedHead")}</span></span>
          {Slot && <Slot slot="git.repository.identity" context={{ projectId, sessionId }} />}
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="git-ahead-behind">
              {status.ahead > 0 && <span className="ahead">↑ {status.ahead}</span>}
              {status.behind > 0 && <span className="behind">↓ {status.behind}</span>}
            </span>
          )}
        </div>
        <div className="source-remote-actions" aria-label={tr("gitview.remoteRepositoryActions")}>
          <Button
            size="sm"
            className="source-action-btn source-sync-btn"
            iconStart={SyncIcon}
            busy={busyRemote !== null}
            disabled={busyRemote !== null || busy}
            onClick={() => void runRemote("sync")}
          >
            {busyRemote ? remoteLabel[busyRemote].busy : remoteLabel.sync.idle}
          </Button>
          <Menu
            label={tr("gitview.remoteRepositoryActions")}
            align="end"
            entries={(["fetch", "pull", "push"] as const).map((step) => ({
              id: step,
              label: remoteLabel[step].idle,
              icon: step === "fetch" ? FetchIcon : step === "pull" ? PullIcon : PushIcon,
              disabled: busyRemote !== null || busy,
              onSelect: () => { void runRemote(step); },
            }))}
          >
            {(trigger) => <IconButton {...trigger} icon={MoreIcon} size="sm" label={tr("gitview.remoteRepositoryActions")} disabled={busy || busyRemote !== null} />}
          </Menu>
          <IconButton icon={RefreshIcon} size="sm" className="source-refresh-btn" label={tr("gitview.refreshSourceControl")} disabled={busy || busyRemote !== null} onClick={() => void refresh()} />
        </div>
      </header>

      {remoteStatus && (
        <div className={`source-inline-status ${remoteStatus.error ? "error" : "success"}`} role={remoteStatus.error ? "alert" : "status"}>
          {remoteStatus.error
            ? tr("gitview.stepFailedValue", { step: remoteLabel[remoteStatus.step].idle, error: remoteStatus.error })
            : tr("gitview.stepCompletedValue", { step: remoteLabel[remoteStatus.step].idle })}
        </div>
      )}

      {remoteStatus?.error && (
        <ConflictAgentBanner
          hint={/diverged|fast-forward|rejected|non-fast-forward/i.test(remoteStatus.error)
            ? tr("gitview.historyDivergedHint")
            : tr("gitview.resolveProblemHint")}
          defaultTarget={settings.conflictAgentTarget}
          hasCurrentSession={!!sessionId}
          busy={conflictAgentBusy}
          message={conflictAgentMsg}
          failed={conflictAgentFailed}
          onResolve={(target) => void startConflictAgent(target, remoteStatus.error)}
        />
      )}

      {loadError && status && (
        <div className="source-inline-status error" role="alert">
          <span>{loadError}</span>
          <Button size="sm" disabled={loading} onClick={() => void refresh(true)}>{tr("common.retry")}</Button>
        </div>
      )}

      {confirmRequest && (
        <Dialog
          title={confirmRequest.title}
          onClose={() => setConfirmRequest(null)}
          initialFocus=".ui-dialog-foot .ui-btn:first-child"
          footer={
            <>
              <Button onClick={() => setConfirmRequest(null)}>{tr("common.cancel")}</Button>
              <Button variant="danger" disabled={busy} onClick={() => {
                const request = confirmRequest;
                setConfirmRequest(null);
                void run(request.action);
              }}>{confirmRequest.confirmLabel}</Button>
            </>
          }
        >
          <div className="source-confirm-dialog">
            <p>{confirmRequest.description}</p>
          </div>
        </Dialog>
      )}

      <Tabs
        className="source-tabs ui-scroll-tabs"
        size="sm"
        label={tr("gitview.sourceControlViews")}
        value={tab}
        tabs={[
          { id: "changes", label: `${tr("gitview.tabChanges")}${all.length ? ` ${all.length}` : ""}` },
          { id: "log", label: tr("gitview.tabLog") },
          { id: "branches", label: `${tr("gitview.tabBranches")} ${branches.branches.length}` },
          { id: "stashes", label: `${tr("gitview.tabStashes")} ${stashes.length}` },
        ]}
        onChange={(value) => selectTab(value as GitTab)}
      />

      {showPrForm && Slot && <Slot slot="git.change-request.create" context={{ projectId, sessionId, selectedProvider: selectedChangeProvider, onSelectProvider: setSelectedChangeProvider, onClose: () => { setShowPrForm(false); setSelectedChangeProvider(null); } }} />}

      {showBranchForm && (
        <div className="source-inline-form">
          <TextInput id="git-new-branch" className="mono" aria-label={tr("gitview.createABranch")} value={newBranch} placeholder={tr("gitview.branchNamePlaceholder")} onChange={(event) => setNewBranch(event.target.value)} />
          <Button variant="primary" disabled={busy || !newBranch.trim()} onClick={() => void run(async () => {
            await api.gitBranch(projectId, newBranch.trim(), undefined, sessionId ?? undefined);
            setNewBranch("");
            setShowBranchForm(false);
            setTab("branches");
          })}>{tr("gitview.createBranch")}</Button>
          <Button variant="ghost" onClick={() => setShowBranchForm(false)}>{tr("common.cancel")}</Button>
        </div>
      )}
      {showTreeForm && (
        <div className="source-inline-form">
          <TextInput id="git-new-worktree" className="mono" aria-label={tr("gitview.createAWorktree")} value={newTree} placeholder={tr("gitview.branchForTheWorktree")} onChange={(event) => setNewTree(event.target.value)} />
          <Button variant="primary" disabled={busy || !newTree.trim()} onClick={() => void run(async () => {
            await api.createWorktree(projectId, newTree.trim());
            setNewTree("");
            setShowTreeForm(false);
            setTab("branches");
          })}>{tr("gitview.createWorktree")}</Button>
          <Button variant="ghost" onClick={() => setShowTreeForm(false)}>{tr("common.cancel")}</Button>
        </div>
      )}
      {tab === "changes" && (
        <div className="git-changes-layout">
          {status && status.conflicted.length > 0 && (
            <ConflictAgentBanner
              hint={tr("gitview.filesConflictedHint", { count: status.conflicted.length })}
              defaultTarget={settings.conflictAgentTarget}
              hasCurrentSession={!!sessionId}
              busy={conflictAgentBusy}
              message={conflictAgentMsg}
              failed={conflictAgentFailed}
              onResolve={(target) => void startConflictAgent(target)}
            />
          )}
          <div className={`git-master-detail ${mobileDetail ? "detail-open" : ""}`}>
            <section className="git-master-pane" aria-label={tr("gitview.changedFiles")}>
              <div className="git-pane-toolbar">
                <div>
                  <strong>{tr("gitview.workingTree")}</strong>
                  <span className="muted">{all.length === 0 ? tr("gitview.clean") : all.length === 1 ? tr("gitview.oneChangedFile") : tr("gitview.changedFilesValue", { count: all.length })}</span>
                </div>
                {(totalFileStats.additions > 0 || totalFileStats.deletions > 0) && (
                  <span
                    className="diff-stat"
                    aria-label={tr("pendingchangesbar.valueAdditionsValueDeletions", {
                      additions: totalFileStats.additions,
                      deletions: totalFileStats.deletions,
                    })}
                  >
                    <span>+{totalFileStats.additions}</span>
                    <span>−{totalFileStats.deletions}</span>
                  </span>
                )}
                <div className="git-pane-actions">
                {(status?.unstaged.length || status?.untracked.length || status?.conflicted.length) ? (
                  <Button size="sm" iconStart={StageIcon} disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "stage", sessionId ?? undefined))}>
                    {tr("gitview.stageAll")}
                  </Button>
                ) : null}
                {(status?.unstaged.length || status?.untracked.length) ? (
                  <Button size="sm" iconStart={DeleteIcon} disabled={busy} onClick={() => setConfirmRequest({
                    title: tr("gitview.revertAllChangesQuestion"),
                    description: tr("pendingchangesbar.undoAllChangesDescription", {
                      count: (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0),
                    }),
                    confirmLabel: tr("gitview.revertAll"),
                    action: () => api.gitFolder(projectId, "", "discard", sessionId ?? undefined),
                  })}>
                    {tr("gitview.revertAll")}
                  </Button>
                ) : null}
                {status && status.staged.length > 0 && (
                  <IconButton icon={UndoIcon} size="sm" label={tr("gitview.unstageAll")} disabled={busy} onClick={() => void run(() => api.gitFolder(projectId, "", "unstage", sessionId ?? undefined))} />
                )}
                </div>
              </div>
              <div className="git-change-groups">
                {changeGroups.map((group) => (
                  <ChangeSection
                    key={group.id}
                    {...group}
                    closed={closedGroups.has(group.id)}
                    selected={selected}
                    busy={busy}
                    fileStats={fileStats}
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
                  <Button size="sm" iconStart={BackIcon} onClick={() => setMobileDetail(false)}>{tr("gitview.tabChanges")}</Button>
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
                      <Button size="sm" onClick={() => setDiffRetry((value) => value + 1)}>{tr("common.retry")}</Button>
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
                      <Textarea autoFocus rows={3} placeholder={tr("gitview.reviewNoteNearLineValue", { line: draft.line })} value={draftText} onChange={(event) => setDraftText(event.target.value)} />
                      <div className="commit-row">
                        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{tr("common.cancel")}</Button>
                        <Button size="sm" variant="primary" disabled={!draftText.trim()} onClick={() => {
                          persistComments([...comments, {
                            id: `rc_${Date.now().toString(36)}`,
                            path: selected.path,
                            digest: draft.digest,
                            line: draft.line,
                            text: draftText.trim(),
                            createdAt: Date.now(),
                          }]);
                          setDraft(null);
                        }}>{tr("gitview.addNote")}</Button>
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
                              <IconButton icon={CloseIcon} size="sm" label={tr("gitview.removeReviewNote")} onClick={() => persistComments(comments.filter((item) => item.id !== comment.id))} />
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
              <Textarea className="commit-msg" minRows={2} maxRows={6} autoGrow placeholder={tr("gitview.commitMessage")} value={commitMsg} onChange={(event) => setCommitMsg(event.target.value)} />
              <div className="commit-row">
                <Button size="sm" iconStart={AssistIcon} busy={generating} disabled={generating || busy} onClick={() => {
                  setGenerating(true);
                  void api.gitCommitMessage(projectId, sessionId ?? undefined)
                    .then((result) => { if (result.message) setCommitMsg(result.message); })
                    .catch((error) => setUiError(friendlyError(tr("gitview.generate"), error)))
                    .finally(() => setGenerating(false));
                }}>{tr("gitview.generate")}</Button>
                <Button size="sm" variant="primary" busy={busy && !!commitMsg.trim()} disabled={!commitMsg.trim() || busy} onClick={() => void run(commitStaged)}>{tr("gitview.commit")}</Button>
                <Button size="sm" iconStart={RefreshIcon} busy={busyRemote === "sync"} disabled={busy || busyRemote !== null} onClick={() => void runRemote("sync")}>{tr("gitview.syncRepository")}</Button>
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
              <TextInput uiSize="sm" value={graphQuery} placeholder={tr("gitview.searchCommitsAuthorsOrRefs")} aria-label={tr("gitview.searchCommitLog")} onChange={(event) => setGraphQuery(event.target.value)} />
              {graphQuery && <IconButton icon={CloseIcon} size="sm" variant="ghost" className="source-search-clear" label={tr("gitview.clearSearch")} onClick={() => setGraphQuery("")} />}
            </div>
            <div className="git-ref-chips ui-scroll-tabs" aria-label={tr("gitview.filterByBranch")}>
              <Button size="sm" variant={!graphRef ? "primary" : "ghost"} aria-pressed={!graphRef} onClick={() => setGraphRef("")}>{tr("gitview.allBranches")}</Button>
              {branchChips.map((ref) => <Button size="sm" variant={graphRef === ref ? "primary" : "ghost"} key={ref} aria-pressed={graphRef === ref} onClick={() => setGraphRef(ref)}>{ref}</Button>)}
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
            {!graphDone && graph.length > 0 && <Button size="sm" className="git-load-more" disabled={graphLoading} onClick={() => void loadMoreGraph()}>{graphLoading ? tr("gitview.loadingOlderCommits") : tr("gitview.loadOlderCommits")}</Button>}
          </section>
          <section className="git-detail-pane">
            {commitSel && (
              <div className="git-mobile-detail-head">
                <Button size="sm" iconStart={BackIcon} onClick={() => setMobileDetail(false)}>{tr("gitview.tabLog")}</Button>
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
                    <Button size="sm" onClick={() => setCommitDiffRetry((value) => value + 1)}>{tr("common.retry")}</Button>
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
            <Button size="sm" iconStart={BranchIcon} onClick={() => {
              setShowBranchForm(true);
              setShowTreeForm(false);
              setShowPrForm(false);
            }}>{tr("gitview.newBranch")}</Button>
            <Button size="sm" iconStart={WorktreeIcon} onClick={() => {
              setShowTreeForm(true);
              setShowBranchForm(false);
              setShowPrForm(false);
            }}>{tr("gitview.newWorktree")}</Button>
            <Button size="sm" variant="primary" iconStart={PullRequestIcon} onClick={() => {
              setShowPrForm(true);
              setShowBranchForm(false);
              setShowTreeForm(false);
            }}>{tr("gitview.createPr")}</Button>
          </div>
          <div className="git-resource-grid">
            <section className="git-resource-card">
              <div className="stat-label">{tr("gitview.currentBranch")}</div>
              <div className="git-current-branch" aria-current="true"><Icon.branch /><span className="mono">{status?.branch || tr("gitview.detachedHead")}</span><span className="tag">{tr("gitview.current")}</span></div>
              <div className="source-search git-branch-search">
                <Icon.search />
                <TextInput uiSize="sm" value={branchQuery} placeholder={tr("gitview.searchLocalAndRemoteBranches")} aria-label={tr("gitview.searchBranches")} onChange={(event) => setBranchQuery(event.target.value)} />
                {branchQuery && <IconButton icon={CloseIcon} size="sm" variant="ghost" className="source-search-clear" label={tr("gitview.clearBranchSearch")} onClick={() => setBranchQuery("")} />}
              </div>
              {(["local", "remote"] as const).map((group) => {
                const remote = group === "remote";
                const label = remote ? tr("gitview.remote") : tr("gitview.local");
                const normalized = branchQuery.trim().toLowerCase();
                const rows = branches.branches.filter((branch) =>
                  !branch.current
                  && !branch.name.startsWith("polyth/isolate/")
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
                          <Button size="sm" className="git-branch-load-more" onClick={() => setBranchLimits((current) => ({ ...current, [group]: current[group] + 30 }))}>
                            {tr("gitview.showMoreValue", { count: 30 })} <span className="muted">{tr("gitview.remainingValue", { count: rows.length - shown.length })}</span>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
            <section className="git-resource-card">
              <div className="stat-label">{tr("gitview.worktreesValue", { count: visibleTrees.length })}</div>
              {!loadError && visibleTrees.length === 0 && <EmptyState title={tr("gitview.noLinkedWorktrees")} description={tr("gitview.newSessionsCurrentlyRunInThe")} />}
              <div className="git-worktree-list">
                {visibleTrees.map((tree) => {
                  const rowBusy = treeBusy?.startsWith(`${tree.path}:`) === true;
                  const stepBusy = (step: string) => treeBusy === `${tree.path}:${step}`;
                  const blocked = busy || treeBusy !== null;
                  // `undefined` means this server did not report status, which
                  // is different from a checkout that is genuinely in sync.
                  const known = tree.ahead !== undefined;
                  const ahead = tree.ahead ?? 0;
                  const behind = tree.behind ?? 0;
                  const changed = tree.changed ?? 0;
                  // The branch this project has checked out is what a merge
                  // lands into, so a worktree cannot be merged into itself.
                  const into = branches.current;
                  const canMerge = !tree.isMain && tree.branch !== null
                    && into !== null && tree.branch !== into;
                  const entries: MenuEntry[] = [];
                  if (canMerge) {
                    entries.push({
                      id: "merge",
                      label: tr("gitview.mergeIntoValue", { branch: into }),
                      icon: CombineIcon,
                      disabled: blocked,
                      onSelect: () => setConfirmRequest({
                        title: tr("gitview.mergeIntoValue", { branch: into }),
                        description: tr("gitview.mergeWorktreeDescription", { branch: tree.branch ?? "", target: into }),
                        confirmLabel: tr("gitview.merge"),
                        action: () => mergeTree(tree),
                      }),
                    });
                  }
                  entries.push(
                    { id: "fetch", label: tr("gitview.fetch"), icon: FetchIcon, disabled: blocked, onSelect: () => { void runTreeRemote(tree, "fetch"); } },
                    { id: "pull", label: tr("gitview.pull"), icon: PullIcon, disabled: blocked, onSelect: () => { void runTreeRemote(tree, "pull"); } },
                    { id: "push", label: tr("gitview.push"), icon: PushIcon, disabled: blocked, onSelect: () => { void runTreeRemote(tree, "push"); } },
                    { id: "sync", label: tr("gitview.syncRepository"), icon: SyncIcon, disabled: blocked, onSelect: () => { void runTreeRemote(tree, "sync"); } },
                  );
                  if (!tree.isMain) {
                    entries.push({
                      id: "remove",
                      label: tr("gitview.removeWorktree"),
                      icon: DeleteIcon,
                      danger: true,
                      disabled: blocked,
                      onSelect: () => requestRemoveTree(tree),
                    });
                  }
                  return (
                    <article key={tree.path} className="git-wt-card">
                      <div className="git-wt-copy">
                        <div className="git-wt-title">
                          <strong className="mono">{tree.branch ?? tr("gitview.detachedHead")}</strong>
                          <span className={`tag ${tree.isMain ? "green" : ""}`}>{tree.isMain ? tr("gitview.main") : tr("gitview.linked")}</span>
                        </div>
                        <span className="muted mono git-wt-path" title={tree.path}>{tree.path}</span>
                        <div className="git-wt-state">
                          <span className="muted mono">{tree.head.slice(0, 7)}</span>
                          {known && ahead > 0 && (
                            <span className="git-wt-stat" title={tr("gitview.commitsToPushValue", { count: ahead })}>
                              <UiIcon icon={PushIcon} size="sm" />{ahead}
                            </span>
                          )}
                          {known && behind > 0 && (
                            <span className="git-wt-stat" title={tr("gitview.commitsToPullValue", { count: behind })}>
                              <UiIcon icon={PullIcon} size="sm" />{behind}
                            </span>
                          )}
                          {known && changed > 0 && (
                            <span className="git-wt-stat git-wt-stat--dirty" title={tr("gitview.uncommittedChangesValue", { count: changed })}>
                              {tr("gitview.changedValue", { count: changed })}
                            </span>
                          )}
                          {known && ahead === 0 && behind === 0 && changed === 0 && (
                            <span className="muted">{tr("gitview.inSync")}</span>
                          )}
                        </div>
                      </div>
                      <div className="git-wt-actions">
                        {/* One adaptive verb: whatever this checkout actually
                            needs next. Everything else stays in the overflow. */}
                        {known && ahead > 0 && (
                          <Button size="sm" variant="primary" iconStart={PushIcon} busy={stepBusy("push")} disabled={blocked} onClick={() => void runTreeRemote(tree, "push")}>
                            {tr("gitview.push")}
                          </Button>
                        )}
                        {known && ahead === 0 && behind > 0 && (
                          <Button size="sm" iconStart={PullIcon} busy={stepBusy("pull")} disabled={blocked} onClick={() => void runTreeRemote(tree, "pull")}>
                            {tr("gitview.pull")}
                          </Button>
                        )}
                        <Button size="sm" iconStart={SessionIcon} disabled={rowBusy} title={tr("gitview.newSessionInValue", { branch: tree.branch ?? tr("gitview.thisWorktree") })} onClick={() => openWorktreeSessionDialog(projectId, tree.path)}>{tr("gitview.session")}</Button>
                        <Menu label={tr("common.more")} align="end" entries={entries}>
                          {(trigger) => (
                            <IconButton
                              {...trigger}
                              icon={MoreIcon}
                              size="sm"
                              busy={rowBusy && !stepBusy("push") && !stepBusy("pull")}
                              disabled={busy}
                              label={tr("gitview.worktreeActionsValue", { branch: tree.branch ?? tree.path })}
                            />
                          )}
                        </Menu>
                      </div>
                    </article>
                  );
                })}
              </div>
              <Button size="sm" className="git-new-session-btn" iconStart={SessionIcon} onClick={() => openWorktreeSessionDialog(projectId)}>{tr("isolation.workInIsolation")}</Button>
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
            <TextInput id="stash-message" aria-label={tr("gitview.stashCurrentChanges")} value={stashMessage} placeholder={tr("gitview.optionalMessage")} onChange={(event) => setStashMessage(event.target.value)} />
            <Button variant="primary" disabled={busy || all.length === 0} onClick={() => void run(async () => {
              await api.gitStashPush(projectId, stashMessage.trim() || undefined, sessionId ?? undefined);
              setStashMessage("");
              setSelected(null);
            })}>{all.length === 1 ? tr("gitview.stashOneFile") : all.length > 1 ? tr("gitview.stashFilesValue", { count: all.length }) : tr("gitview.stashChanges")}</Button>
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
                  <Button size="sm" disabled={busy} onClick={() => void run(() => api.gitStashApply(projectId, stash.ref, sessionId ?? undefined))}>{tr("common.apply")}</Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirmRequest({
                    title: tr("gitview.dropStashQuestion"),
                    description: tr("gitview.stashWillBePermanentlyDeleted", { ref: stash.ref }),
                    confirmLabel: tr("gitview.dropStash"),
                    action: () => api.gitStashDrop(projectId, stash.ref, sessionId ?? undefined),
                  })}>{tr("gitview.drop")}</Button>
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
        <IconButton icon={AddIcon} size="sm" variant="ghost" className="hunk-comment-btn" title={tr("gitview.addReviewNoteForThisHunk")} label={tr("gitview.addReviewNote")} onClick={onComment} />
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
        <Button size="sm" variant={prefs.layout === "unified" ? "primary" : "ghost"} aria-pressed={prefs.layout === "unified"} onClick={() => setGitPrefs({ layout: "unified" })}>{tr("gitview.unified")}</Button>
        <Button size="sm" variant={prefs.layout === "split" ? "primary" : "ghost"} aria-pressed={prefs.layout === "split"} onClick={() => setGitPrefs({ layout: "split" })}>{tr("gitview.split")}</Button>
      </div>
      <Checkbox checked={prefs.ignoreWhitespace} onChange={(checked) => setGitPrefs({ ignoreWhitespace: checked })} label={tr("gitview.ignoreWhitespace")} />
      <Checkbox checked={prefs.wrap} onChange={(checked) => setGitPrefs({ wrap: checked })} label={tr("gitview.wrapLines")} />
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
