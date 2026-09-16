import { useEffect, useState } from "react";
import { api, type ScheduleRunDto, type ScheduleTaskDto } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import EmptyState from "../../../apps/web/src/components/EmptyState.tsx";
import { Button, ResponsiveOverlay } from "../../../apps/web/src/components/ui/index.ts";

function statusLabel(status: ScheduleRunDto["status"]): string {
  if (status === "ok") return tr("scheduleview.runOk");
  if (status === "failed") return tr("scheduleview.runFailed");
  if (status === "running") return tr("scheduleview.runRunning");
  return tr("scheduleview.runSkipped");
}

export default function PlannerRunHistory({
  task,
  onClose,
}: {
  task: ScheduleTaskDto | null;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<ScheduleRunDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!task) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    void api.scheduleRuns(task.id)
      .then((next) => {
        if (active) setRuns(next);
      })
      .catch((cause) => {
        if (active) {
          setRuns([]);
          setLoadError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [task, reloadKey]);

  return (
    <ResponsiveOverlay
      open={task !== null}
      onClose={onClose}
      title={tr("scheduleview.runs")}
      desktop="dialog"
      dialogSize="md"
      className="planner-sheet-overlay"
      dialogFooter={<Button onClick={onClose}>{tr("common.close")}</Button>}
    >
      {loading && (
        <div className="loading-state" role="status" aria-label={tr("scheduleview.loadingRuns")}>
          <span /><span /><span />
        </div>
      )}
      {!loading && loadError && (
        <EmptyState
          variant="compact"
          title={tr("scheduleview.couldnTLoadRuns")}
          description={loadError}
          actionLabel={tr("common.retry")}
          onAction={() => setReloadKey((key) => key + 1)}
        />
      )}
      {!loading && !loadError && runs.length === 0 && (
        <EmptyState variant="compact" title={tr("scheduleview.noRunsRecordedYet")} />
      )}
      {!loading && !loadError && runs.length > 0 && (
        <div className="planner-runs">
          {runs.map((run) => (
            <div key={run.runId} className="planner-run">
              <span className={`planner-run-dot ${run.status}`} />
              <span className="planner-run-when">
                {new Date(run.startedAt).toLocaleString(getLocale())}
              </span>
              <span>{statusLabel(run.status)}</span>
              {run.finishedAt !== undefined && (
                <span className="muted">{Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))}s</span>
              )}
              {run.error && <span className="planner-run-error">{run.error}</span>}
            </div>
          ))}
        </div>
      )}
    </ResponsiveOverlay>
  );
}
