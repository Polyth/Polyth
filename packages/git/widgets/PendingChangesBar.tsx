import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGitStatus } from "./gitStatusStore.ts";
import { selectPendingChanges } from "../../../apps/web/src/pendingChanges.ts";
import { openChanges, useActiveModel, useStore } from "../../../apps/web/src/store.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { api } from "@polyth/session/web-api";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useDismissibleMenu } from "../../../apps/web/src/components/a11y/Menu.ts";

export interface DiffLineStats {
  additions: number;
  deletions: number;
}

export interface PendingChangesMenuPosition {
  left: number;
  bottom: number;
  width: number;
}

/** Position the fixed menu inside a 12px viewport gutter, even beside narrow composers. */
export function pendingChangesMenuPosition(
  trigger: Pick<DOMRect, "right" | "top">,
  viewport: { width: number; height: number },
): PendingChangesMenuPosition {
  const gutter = 12;
  const width = Math.max(0, Math.min(420, viewport.width - gutter * 2));
  const idealLeft = trigger.right - width;
  const left = Math.max(gutter, Math.min(idealLeft, viewport.width - width - gutter));
  return {
    left,
    bottom: Math.max(gutter, viewport.height - trigger.top + 8),
    width,
  };
}

interface DiffStatsSnapshot {
  changeKey: string;
  value: DiffLineStats;
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
  const [dismissedKey, setDismissedKey] = useState("");
  const [diffStats, setDiffStats] = useState<DiffStatsSnapshot | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<PendingChangesMenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onMenuKeyDown = useDismissibleMenu({
    open: menuOpen,
    menuRef,
    triggerRef,
    onClose: () => setMenuOpen(false),
  });

  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current) {
      setMenuPosition(null);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      setMenuPosition(pendingChangesMenuPosition(trigger.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    let cancelled = false;
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
      setDiffStats({
        changeKey,
        value: parts.reduce<DiffLineStats>(
          (total, part) => ({
            additions: total.additions + part.additions,
            deletions: total.deletions + part.deletions,
          }),
          { additions: 0, deletions: 0 },
        ),
      });
    }).catch(() => {
      // Preserve the last known totals during a transient refresh failure.
    });
    return () => { cancelled = true; };
  }, [changeKey, projectId, selected.source, sessionId, status]);

  if (selected.paths.length === 0 || dismissedKey === changeKey) return null;
  const count = selected.paths.length;
  const visibleStats = diffStats?.changeKey === changeKey ? diffStats.value : null;

  return (
    <div className="pending-changes-bar" role="status">
      <button className="pending-changes-main" onClick={() => openChanges()}>
        <span className="pending-changes-icon" aria-hidden="true">
          <Icon.fileEdit />
        </span>
        {count} {count === 1 ? tr("pendingchangesbar.file") : tr("pendingchangesbar.files")}
        {visibleStats && (
          <span
            className="pending-change-stats"
            aria-label={tr("pendingchangesbar.valueAdditionsValueDeletions", { additions: visibleStats.additions, deletions: visibleStats.deletions })}
          >
            <span className="additions" aria-hidden="true">+{visibleStats.additions}</span>
            <span className="deletions" aria-hidden="true">-{visibleStats.deletions}</span>
          </span>
        )}
      </button>
      <div className="pending-changes-files">
        <button
          ref={triggerRef}
          className="pending-changes-trigger"
          aria-label={tr("pendingchangesbar.listChangedFiles")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        ><Icon.chevronDown /></button>
        {menuOpen && <div ref={menuRef} className="pending-changes-menu" role="menu" aria-label={tr("pendingchangesbar.changedFiles")} style={menuPosition ?? undefined} onKeyDown={onMenuKeyDown}>

          {selected.paths.map((path) => (
            <button key={path} role="menuitem" className="mono" title={path} onClick={() => {
              setMenuOpen(false);
              openChanges(path);
            }}>
              {path}
            </button>
          ))}
        </div>}
      </div>
      <button
        className="pending-changes-dismiss"
        aria-label={tr("pendingchangesbar.dismissChangedFiles")}
        title={tr("pendingchangesbar.dismissUntilTheFileSetChanges")}
        onClick={() => setDismissedKey(changeKey)}
      >
        {tr("pendingchangesbar.message")}</button>
    </div>
  );
}
