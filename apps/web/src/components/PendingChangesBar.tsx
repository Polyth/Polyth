import { useEffect, useMemo, useState } from "react";
import type { RenderModel } from "../reduce.ts";
import { useGitStatus } from "../gitStatusStore.ts";
import { selectPendingChanges } from "../pendingChanges.ts";
import { openChanges, useStore } from "../store.ts";
import { Icon } from "../icons.tsx";
import { api } from "../api.ts";

export interface DiffLineStats {
  additions: number;
  deletions: number;
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

export default function PendingChangesBar({ model }: { model: RenderModel }) {
  const projectId = useStore((state) => state.activeProjectId);
  const sessionId = useStore((state) => state.activeSessionId);
  const working = model.turn?.status === "working";
  const status = useGitStatus(projectId, working, sessionId);
  const selected = useMemo(
    () => selectPendingChanges(status, model.changedFiles),
    [status, model.changedFiles],
  );
  const changeKey = `${selected.source}:${[...selected.paths].sort().join("\0")}`;
  const [dismissedKey, setDismissedKey] = useState("");
  const [diffStats, setDiffStats] = useState<DiffLineStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiffStats(null);
    if (!projectId || !status || selected.source !== "git") return;

    const requests: Array<Promise<DiffLineStats>> = [];
    for (const path of selected.paths) {
      if (status.staged.some((file) => file.path === path)) {
        requests.push(api.gitDiff(projectId, path, true, false, sessionId ?? undefined)
          .then((result) => summarizeUnifiedDiff(result.diff)));
      }
      if ([...status.unstaged, ...status.untracked, ...status.conflicted].some((file) => file.path === path)) {
        requests.push(api.gitDiff(projectId, path, false, false, sessionId ?? undefined)
          .then((result) => summarizeUnifiedDiff(result.diff)));
      }
    }

    void Promise.all(requests).then((parts) => {
      if (cancelled) return;
      setDiffStats(parts.reduce<DiffLineStats>(
        (total, part) => ({
          additions: total.additions + part.additions,
          deletions: total.deletions + part.deletions,
        }),
        { additions: 0, deletions: 0 },
      ));
    }).catch(() => {
      if (!cancelled) setDiffStats(null);
    });
    return () => { cancelled = true; };
  }, [changeKey, projectId, selected.source, sessionId, status]);

  if (selected.paths.length === 0 || dismissedKey === changeKey) return null;
  const count = selected.paths.length;

  return (
    <div className="pending-changes-bar" role="status">
      <button className="pending-changes-main" onClick={() => openChanges()}>
        <span className="pending-changes-icon" aria-hidden="true">
          <Icon.fileEdit />
        </span>
        {count} {count === 1 ? "file" : "files"}
        {diffStats && (
          <span
            className="pending-change-stats"
            aria-label={`${diffStats.additions} additions, ${diffStats.deletions} deletions`}
          >
            <span className="additions" aria-hidden="true">+{diffStats.additions}</span>
            <span className="deletions" aria-hidden="true">-{diffStats.deletions}</span>
          </span>
        )}
      </button>
      <details className="pending-changes-files">
        <summary aria-label="List changed files"><Icon.chevronDown /></summary>
        <div className="pending-changes-menu">
          {selected.paths.map((path) => (
            <button key={path} className="mono" title={path} onClick={() => openChanges(path)}>
              {path}
            </button>
          ))}
        </div>
      </details>
      <button
        className="pending-changes-dismiss"
        aria-label="Dismiss changed files"
        title="Dismiss until the file set changes"
        onClick={() => setDismissedKey(changeKey)}
      >
        ×
      </button>
    </div>
  );
}
