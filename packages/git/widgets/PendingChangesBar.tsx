import { useEffect, useMemo, useState } from "react";
import { useGitStatus, refreshGitStatus } from "./gitStatusStore.ts";
import { selectPendingChanges } from "../../../apps/web/src/pendingChanges.ts";
import { openChanges, setUiError, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
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
  const projectId = useStore((state) => state.activeProjectId);
  // Sessions without a worktree resolve to the project's primary checkout —
  // scope status/diff reads to the project entry so spawning or switching such
  // sessions never triggers an extra git fetch (worktree sessions stay scoped).
  const sessionId = useStore((state) => {
    const session = state.sessions.find((candidate) => candidate.id === state.activeSessionId);
    return session?.worktreePath ? session.id : null;
  });
  const working = model.turn?.status === "working";
  const status = useGitStatus(projectId, working, sessionId);
  const selected = useMemo(
    () => selectPendingChanges(status, model.changedFiles),
    [status, model.changedFiles],
  );
  const changeKey = `${selected.source}:${[...selected.paths].sort().join("\0")}`;
  const [diffStats, setDiffStats] = useState<DiffStatsSnapshot | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [changeKey]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId || !status || selected.source !== "git") {
      setDiffStats(null);
      return;
    }

    const requests = selected.paths.map(async (path) => {
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
      setDiffStats({ changeKey, files: Object.fromEntries(entries) });
    });
    return () => { cancelled = true; };
  }, [changeKey, projectId, selected.paths, selected.source, sessionId, status]);

  if (selected.paths.length === 0) return null;
  const count = selected.paths.length;
  const title = count === 1
    ? tr("pendingchangesbar.editedOneFile")
    : tr("pendingchangesbar.editedFilesValue", { count });
  const fileStats = diffStats?.changeKey === changeKey ? diffStats.files : null;
  const totals = fileStats ? totalDiffStats(Object.values(fileStats)) : null;
  const visible = visibleEditedPaths(selected.paths, expanded);
  const overflow = hiddenEditedCount(count);
  const canUndo = selected.source === "git" && Boolean(projectId);
  const moreLabel = expanded
    ? tr("pendingchangesbar.showLess")
    : overflow === 1
      ? tr("pendingchangesbar.showMoreFile")
      : tr("pendingchangesbar.showMoreFilesValue", { count: overflow });

  const undoAll = async () => {
    if (!projectId || !canUndo || undoing) return;
    const message = count === 1
      ? tr("gitview.allUncommittedChangesInValue", { path: selected.paths[0]! })
      : tr("pendingchangesbar.undoAllChangesDescription", { count });
    if (!await confirmAlert(message, {
      title: tr("pendingchangesbar.undoAllChanges"),
      confirmLabel: tr("pendingchangesbar.undo"),
    })) return;
    setUndoing(true);
    try {
      await api.gitDiscard(projectId, selected.paths, sessionId ?? undefined);
      await refreshGitStatus(projectId, sessionId);
    } catch (cause) {
      setUiError(friendlyError(tr("gitview.couldntUpdateTheRepository"), cause));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <section className="pending-changes-bar" aria-label={title}>
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
          iconEnd={expanded ? ChevronUpIcon : ChevronDownIcon}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {moreLabel}
        </Button>
      )}
    </section>
  );
}
