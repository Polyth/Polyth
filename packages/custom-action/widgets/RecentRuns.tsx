// Recent runs: a quiet accordion under the launcher. Closed by default (the
// header carries the count and the latest result); the choice is remembered
// on this device under a package-scoped key.
import { useId, useState } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { ChevronDownIcon, Icon } from "../../../apps/web/src/components/ui/index.ts";
import type { ActionRunDto } from "../src/actionModel.ts";
import ActionGlyph from "./ActionGlyph.tsx";
import type { ActionsSnapshot } from "./store.ts";
import { tileView } from "./tileState.ts";
import { ago, duration, stopwatch } from "./time.ts";

const OPEN_KEY = "custom-action.recentRunsOpen";

export function readRecentOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
}
function writeRecentOpen(open: boolean): void {
  try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch { /* private mode: page-life only */ }
}

export function runStatusLabel(run: ActionRunDto): string {
  switch (run.status) {
    case "running": return tr("customaction.status.running");
    case "succeeded": return run.chatSessionId ? tr("customaction.status.chatStarted") : tr("customaction.status.done");
    case "failed": return tr("customaction.status.exitCode", { code: String(run.exitCode ?? "?") });
    case "stopped": return tr("customaction.status.stopped");
    case "timed-out": return tr("customaction.status.timedOut");
    default: return tr("customaction.status.error");
  }
}

export default function RecentRuns({
  runs,
  total = runs.length,
  seen,
  now,
  onOpen,
}: {
  runs: readonly ActionRunDto[];
  /** All of the project's runs; `runs` is only the newest few. */
  total?: number;
  seen: ActionsSnapshot["seen"];
  now: number;
  onOpen: (runId: string, anchor: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(readRecentOpen);
  const bodyId = useId();
  const latest = runs[0];
  if (!latest) return null;
  const toggle = () => {
    setOpen((value) => {
      writeRecentOpen(!value);
      return !value;
    });
  };
  return (
    <section className="ca-recent" data-open={open || undefined} aria-label={tr("customaction.recent.title")}>
      <button type="button" className="ca-recent-head" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
        <span className="ca-recent-title">{tr("customaction.recent.title")}</span>
        <span className="ca-section-count">{total}</span>
        <span className="ca-recent-latest" data-status={latest.status}>
          <span className="ca-recent-dot" aria-hidden="true" />
          <span className="ca-recent-latest-text">{latest.name} · {runStatusLabel(latest)}</span>
        </span>
        <Icon icon={ChevronDownIcon} size="sm" className="ca-recent-chevron" />
      </button>
      <div className="ca-recent-body" id={bodyId} inert={!open}>
        <div className="ca-recent-inner">
          <ul className="ca-runs">
            {runs.map((run) => {
              const view = tileView({ runs: [run], launches: {}, seen }, run.actionId, run.projectId, now);
              return (
                <li key={run.id}>
                  <button type="button" className="ca-run-row" onClick={(event) => onOpen(run.id, event.currentTarget)}>
                    <ActionGlyph icon={run.icon} color={run.color} size="sm" state={run.status === "running" ? view.state : "idle"} />
                    <span className="ca-run-row-name">{run.name}</span>
                    <span className="ca-run-row-status" data-status={run.status}>{runStatusLabel(run)}</span>
                    <span className="ca-run-row-time">
                      {run.finishedAt ? `${duration(run.finishedAt - run.startedAt)} · ${ago(run.finishedAt, now)}` : stopwatch(now - run.startedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
