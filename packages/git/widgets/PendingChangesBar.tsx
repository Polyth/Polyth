import { useEffect, useMemo, useState, useRef } from "react";
import { noteGitActivity, useGitStatus, refreshGitStatus } from "./gitStatusStore.ts";
import { selectPendingChanges, sessionEditedPaths } from "../../../apps/web/src/pendingChanges.ts";
import {
  isActiveSessionSpawning,
  openChanges,
  useActiveModel,
  usePendingSends,
  useStore,
  workspaceProjectId,
} from "../../../apps/web/src/store.ts";
import { resolveSessionActivity } from "../../../apps/web/src/sessionActivity.ts";
import { reportGitError } from "./gitRefusal.ts";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import AgentLiveStatusDock from "../../../apps/web/src/components/AgentLiveStatusDock.tsx";
import {
  Button,
  ChevronDownIcon,
  ChevronUpIcon,
  confirmAlert,
  FileDiffIcon,
  Icon,
  IconButton,
  RunSummary,
  UndoIcon,
} from "../../../apps/web/src/components/ui/index.ts";

export interface DiffLineStats {
  additions: number;
  deletions: number;
}

export const EDITED_FILES_PREVIEW = 3;
const DIFF_STAT_READERS = 3;
const DIFF_STAT_SETTLE_MS = 300;
const DIFF_STAT_TURN_GAP_MS = 5_000;

const EMPTY_STATS: DiffLineStats = { additions: 0, deletions: 0 };

interface DiffStatsSnapshot {
  changeKey: string;
  files: Record<string, DiffLineStats>;
}

/** Count unified-diff content lines while excluding the file headers. */
export function summarizeUnifiedDiff(diff: string): DiffLineStats {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function addDiffStats(left: DiffLineStats, right: DiffLineStats): DiffLineStats {
  return { additions: left.additions + right.additions, deletions: left.deletions + right.deletions };
}

export function totalDiffStats(parts: Iterable<DiffLineStats>): DiffLineStats {
  let total = EMPTY_STATS;
  for (const part of parts) total = addDiffStats(total, part);
  return total;
}

/** First three paths until the user expands the remainder. */
export function visibleEditedPaths(
  paths: readonly string[],
  expanded: boolean,
  preview = EDITED_FILES_PREVIEW,
): string[] {
  if (expanded || paths.length <= preview) return [...paths];
  return paths.slice(0, preview);
}

export function hiddenEditedCount(pathCount: number, preview = EDITED_FILES_PREVIEW): number {
  return Math.max(0, pathCount - preview);
}

function DiffTotals({ stats }: { stats: DiffLineStats }) {
  if (stats.additions === 0 && stats.deletions === 0) return null;
  return (
    <span
      className="pending-change-stats"
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

export default function PendingChangesBar() {
  const model = useActiveModel();
  const sessionRecord = useStore((state) =>
    state.sessions.find((candidate) => candidate.id === state.activeSessionId) ?? null);
  const pendingSends = usePendingSends(sessionRecord?.id ?? null);
  const spawning = useStore(isActiveSessionSpawning);
  const activity = resolveSessionActivity(sessionRecord, model.turn, pendingSends);
  const projectId = useStore(workspaceProjectId);
  const repoRoot = useStore((state) => {
    const id = workspaceProjectId(state);
    if (!id) return null;
    return state.projectRegistry.projects.find((project) => project.id === id)?.path ?? null;
  });
  // Sessions without a worktree resolve to the project's primary checkout —
  // scope status/diff reads to the project entry so spawning or switching such
  // sessions never triggers an extra git fetch (worktree sessions stay scoped).
  const sessionId = useStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === state.activeSessionId);
    return session?.worktreePath ? session.id : null;
  });
  const working = activity.working;
  const awaitingTurn = activity.awaitingTurn;
  const status = useGitStatus(projectId, working ? "turn" : false, sessionId);
  // `model.messages` changes with every streamed event; everything below keys
  // on what it means for Git, or each event would read every file's diff again.
  const editedKey = sessionEditedPaths(model.messages).join("\0");
  const finishedTools = model.messages.reduce(
    (count, message) => count + (message.kind === "tool" && (message.status === "done" || message.status === "error") ? 1 : 0),
    0,
  );
  useEffect(() => {
    if (projectId && working && finishedTools > 0) noteGitActivity(projectId, sessionId);
  }, [finishedTools, projectId, sessionId, working]);
  const selected = useMemo(
    () => selectPendingChanges(status, editedKey ? editedKey.split("\0") : [], repoRoot),
    [status, editedKey, repoRoot],
  );
  const changeKey = [...selected.paths].sort().join("\0");
  const [diffStats, setDiffStats] = useState<DiffStatsSnapshot | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const statRound = useRef({ at: 0, tookMs: 0 });
  useEffect(() => {
    setFilesExpanded(false);
  }, [changeKey]);

  useEffect(() => {
    let cancelled = false;
    const keepKnownStats = (prev: DiffStatsSnapshot | null): DiffStatsSnapshot | null => {
      if (!prev) return null;
      const files: Record<string, DiffLineStats> = {};
      for (const path of selected.paths) {
        const stats = prev.files[path];
        if (stats) files[path] = stats;
      }
      return { changeKey, files };
    };
    if (!projectId || !status || selected.dirtyPaths.length === 0) {
      setDiffStats(keepKnownStats);
      return;
    }

    const readStats = async (path: string) => {
      const parts: DiffLineStats[] = [];
      if (status.staged.some((file) => file.path === path)) {
        try {
          const result = await api.gitDiff(projectId, path, true, false, sessionId ?? undefined);
          parts.push(summarizeUnifiedDiff(result.diff));
        } catch {
          // Keep the rest of the card if one staged patch cannot be read.
        }
      }
      if ([...status.unstaged, ...status.untracked, ...status.conflicted].some((file) => file.path === path)) {
        try {
          const result = await api.gitDiff(projectId, path, false, false, sessionId ?? undefined);
          parts.push(summarizeUnifiedDiff(result.diff));
        } catch {
          // Keep the rest of the card if one working-tree patch cannot be read.
        }
      }
      return [path, totalDiffStats(parts)] as const;
    };
    // Each read starts a Git process on the server. A few at a time, after the
    // status has settled, and none once this status is out of date.
    const paths = [...selected.dirtyPaths];
    const entries: Array<readonly [string, DiffLineStats]> = [];
    const worker = async () => {
      for (let path = paths.shift(); path !== undefined && !cancelled; path = paths.shift()) {
        entries.push(await readStats(path));
      }
    };
    // Line counts can move while a file's status does not, so a finished tool
    // asks again: once per settled round during a turn, at once outside one.
    const startRound = () => {
      const startedAt = Date.now();
      void Promise.all(Array.from({ length: DIFF_STAT_READERS }, worker)).then(() => {
        statRound.current = { at: Date.now(), tookMs: Date.now() - startedAt };
        if (cancelled) return;
        setDiffStats((prev) => {
          const files: Record<string, DiffLineStats> = {};
          for (const path of selected.paths) {
            const previous = prev?.files[path];
            if (previous) files[path] = previous;
          }
          for (const [path, stats] of entries) {
            const empty = stats.additions === 0 && stats.deletions === 0;
            if (!empty || files[path] === undefined) files[path] = stats;
          }
          return { changeKey, files };
        });
      });
    };
    const round = statRound.current;
    const gap = Math.max(DIFF_STAT_TURN_GAP_MS, round.tookMs * 10);
    const wait = working ? Math.max(DIFF_STAT_SETTLE_MS, round.at + gap - Date.now()) : 0;
    const delay = setTimeout(startRound, wait);
    return () => {
      cancelled = true;
      clearTimeout(delay);
    };
  }, [changeKey, finishedTools, projectId, selected.dirtyPaths, selected.paths, sessionId, status, working]);

  const count = selected.paths.length;
  const title = count === 1
    ? tr("pendingchangesbar.editedOneFile")
    : tr("pendingchangesbar.editedFilesValue", { count });
  const bubbleCount = count === 1
    ? tr("pendingchangesbar.bubbleCountOne")
    : tr("pendingchangesbar.bubbleCountValue", { count });
  const fileStats = diffStats?.changeKey === changeKey ? diffStats.files : null;
  const totals = fileStats ? totalDiffStats(Object.values(fileStats)) : null;
  const visible = visibleEditedPaths(selected.paths, filesExpanded);
  const overflow = hiddenEditedCount(count);
  const canUndo = selected.dirtyPaths.length > 0 && Boolean(projectId);
  const moreLabel = filesExpanded
    ? tr("pendingchangesbar.showLess")
    : tr("pendingchangesbar.moreValue", { count: overflow });

  if (working) {
    return (
      <AgentLiveStatusDock
        activity={activity}
        model={model}
        files={count > 0 ? bubbleCount : null}
        {...(totals ? { additions: totals.additions, deletions: totals.deletions } : {})}
        diffLabel={tr("pendingchangesbar.valueAdditionsValueDeletions", {
          additions: totals?.additions ?? 0,
          deletions: totals?.deletions ?? 0,
        })}
      />
    );
  }

  // The startup dock owns the pre-working handoff. Projection status is part
  // of "working" so the live activity dock wins as soon as the server marks
  // the session active, even if turn/started or spawn cleanup arrives later.
  if (spawning || awaitingTurn) return null;

  if (selected.paths.length === 0) return null;

  const undoAll = async () => {
    if (!projectId || !canUndo || undoing) return;
    const dirtyCount = selected.dirtyPaths.length;
    const message = dirtyCount === 1
      ? tr("gitview.allUncommittedChangesInValue", { path: selected.dirtyPaths[0]! })
      : tr("pendingchangesbar.undoAllChangesDescription", { count: dirtyCount });
    if (!await confirmAlert(message, {
      title: tr("pendingchangesbar.undoAllChanges"),
      confirmLabel: tr("pendingchangesbar.undo"),
    })) return;
    setUndoing(true);
    try {
      await api.gitDiscard(projectId, selected.dirtyPaths, sessionId ?? undefined);
      await refreshGitStatus(projectId, sessionId);
    } catch (cause) {
      reportGitError(tr("gitview.couldntUpdateTheRepository"), cause);
    } finally {
      setUndoing(false);
    }
  };

  if (!detailsOpen) {
    return (
      <section className="pending-changes-bar pending-changes-bar--collapsed">
        <RunSummary
          title={title}
          state="completed"
          expanded={false}
          additions={totals?.additions}
          deletions={totals?.deletions}
          label={title}
          diffLabel={tr("pendingchangesbar.valueAdditionsValueDeletions", {
            additions: totals?.additions ?? 0,
            deletions: totals?.deletions ?? 0,
          })}
          onToggle={() => setDetailsOpen(true)}
        />
      </section>
    );
  }

  return (
    <section className="pending-changes-bar" aria-label={title}>
      <div className="pending-changes-body">
        <div className="pending-changes-lead">
          <span className="pending-changes-icon" aria-hidden="true">
            <Icon icon={FileDiffIcon} size="sm" />
          </span>
          <div className="pending-changes-copy">
            <span className="pending-changes-title">{title}</span>
            {totals && <DiffTotals stats={totals} />}
          </div>
        </div>
        <div className="pending-changes-actions">
          {canUndo && (
            <Button
              variant="ghost"
              size="sm"
              iconStart={UndoIcon}
              busy={undoing}
              aria-label={tr("pendingchangesbar.undo")}
              onClick={() => void undoAll()}
            >
              {tr("pendingchangesbar.undo")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="pending-changes-review"
            disabled={undoing}
            onClick={() => openChanges()}
          >
            {tr("pendingchangesbar.review")}
          </Button>
        </div>
        <IconButton
          className="pending-changes-toggle"
          variant="ghost"
          size="sm"
          icon={ChevronDownIcon}
          label={tr("pendingchangesbar.collapse")}
          onClick={() => setDetailsOpen(false)}
        />
        <div className="pending-changes-list">
          {visible.map((path) => (
            <button
              key={path}
              type="button"
              className="pending-changes-file"
              title={path}
              onClick={() => openChanges(path)}
            >
              <span className="pending-changes-file-name">{path}</span>
              {fileStats?.[path] && <DiffTotals stats={fileStats[path]!} />}
            </button>
          ))}
        </div>
        {overflow > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="pending-changes-more"
            iconEnd={filesExpanded ? ChevronUpIcon : ChevronDownIcon}
            aria-expanded={filesExpanded}
            onClick={() => setFilesExpanded((open) => !open)}
          >
            {moreLabel}
          </Button>
        )}
      </div>
    </section>
  );
}
