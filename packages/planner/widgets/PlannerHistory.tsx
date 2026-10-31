import { useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import type { PlannerRunRecord, PlannerRunStatus } from "../src/model.ts";
import { ChatIcon, Icon } from "../../../apps/web/src/components/ui/index.ts";
import { formatDuration, formatPreviewRun } from "./plannerFormat.ts";
import { t } from "./plannerText.ts";

const COLLAPSED = 5;

const STATUS_LABEL: Record<PlannerRunStatus, Parameters<typeof t>[0]> = {
  ok: "history.ok",
  failed: "history.failed",
  running: "history.running",
  skipped: "history.skipped",
  unknown: "history.unknown",
};

export default function PlannerHistory({ runs, locale, now, host }: {
  runs: readonly PlannerRunRecord[];
  locale: string;
  now: number;
  host?: WebPackageHost;
}) {
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return <p className="planner-history-empty">{t("history.empty")}</p>;
  const visible = expanded ? runs : runs.slice(0, COLLAPSED);
  return (
    <div className="planner-history">
      <ol className="planner-history-list">
        {visible.map((run) => (
          <li key={run.runId} className="planner-run" data-status={run.status}>
            <span className="planner-run-dot" aria-hidden="true" />
            <div className="planner-run-body">
              <div className="planner-run-line">
                <span className="planner-run-status">{t(STATUS_LABEL[run.status])}</span>
                <time className="planner-run-when" dateTime={new Date(run.startedAt).toISOString()}>
                  {formatPreviewRun(run.startedAt, now, locale)}
                </time>
                {run.finishedAt !== undefined && run.status !== "skipped" && (
                  <span className="planner-run-meta">{formatDuration(run.finishedAt - run.startedAt, locale)}</span>
                )}
                {run.manual && <span className="planner-run-tag">{t("history.manual")}</span>}
                {run.late && <span className="planner-run-tag">{t("history.late")}</span>}
              </div>
              {run.error && <p className="planner-run-error">{run.error}</p>}
            </div>
            {run.sessionId && host && (
              <button
                type="button"
                className="planner-run-open"
                onClick={() => void host.conversation.openSession(run.sessionId!)}
              >
                <Icon icon={ChatIcon} size="sm" />
                <span>{t("history.openChat")}</span>
              </button>
            )}
          </li>
        ))}
      </ol>
      {runs.length > COLLAPSED && (
        <button type="button" className="planner-link" onClick={() => setExpanded((next) => !next)}>
          {expanded ? t("history.showLess") : t("history.showAll", { count: runs.length })}
        </button>
      )}
    </div>
  );
}
