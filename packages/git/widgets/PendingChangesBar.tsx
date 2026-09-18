import { useEffect, useMemo, useState } from "react";
import { useGitStatus, refreshGitStatus } from "./gitStatusStore.ts";
import { selectPendingChanges, sessionEditedPaths } from "../../../apps/web/src/pendingChanges.ts";
import {
  isActiveSessionSpawning,
  openChanges,
  setUiError,
  useActiveModel,
  usePendingSends,
  useStore,
  workspaceProjectId,
} from "../../../apps/web/src/store.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
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
  const working = model.turn?.status === "working" || sessionRecord?.status === "working";
  const awaitingTurn = pendingSends.length > 0 && !working;
  const status = useGitStatus(projectId, working, sessionId);
  const selected = useMemo(
    () => selectPendingChanges(status, sessionEditedPaths(model.messages), repoRoot),
    [status, model.messages, repoRoot],
  );
  const changeKey = [...selected.paths].sort().join("\0");
  const [diffStats, setDiffStats] = useState<DiffStatsSnapshot | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);
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

    const requests = selected.dirtyPaths.map(async (path) => {
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
    });

    void Promise.all(requests).then((entries) => {
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
    return () => { cancelled = true; };
  }, [changeKey, projectId, selected.dirtyPaths, selected.paths, sessionId, status]);

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
    : overflow === 1
      ? tr("pendingchangesbar.showMoreFile")
      : tr("pendingchangesbar.showMoreFilesValue", { count: overflow });

  // SessionSurface owns Spawning, Starting, and live agent activity. This
  // widget contributes only the idle edited-files summary, so it yields for
  // the entire active lifecycle and can never overlap the activity dock.
  if (working || spawning || awaitingTurn) return null;

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
      setUiError(friendlyError(tr("gitview.couldntUpdateTheRepository"), cause));
    } finally {
      setUndoing(false);
    }
  };

  if (!detailsOpen) {
    return (
      <section className="pending-changes-bar pending-changes-bar--collapsed">
        <RunSummary
          className="ui-glass-dock ui-glass-dock--medium"
          title={title}
          meta={bubbleCount}
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
    <section className="ui-glass-dock ui-glass-dock--strong pending-changes-bar" aria-label={title}>
      <div className="pending-changes-head">
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
            variant="quiet"
            size="sm"
            className="pending-changes-review"
            disabled={undoing}
            onClick={() => openChanges()}
          >
            {tr("pendingchangesbar.review")}
          </Button>
          <IconButton
            variant="ghost"
            size="sm"
            icon={ChevronDownIcon}
            label={tr("pendingchangesbar.collapse")}
            onClick={() => setDetailsOpen(false)}
          />
        </div>
      </div>
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
    </section>
  );
}
