import { useEffect, useState } from "react";
import type { WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { openSession } from "../../../apps/web/src/init.ts";
import { Icon } from "../../../apps/web/src/icons.tsx";
import { getState, openWorkspacePane, setUiError } from "../../../apps/web/src/store.ts";
import { handOffWorkflowLaunch } from "./workflowLaunch.ts";
import { publishWorkflowRun } from "./workflowMonitor.ts";
import { friendlyError } from "../../../apps/web/src/settings.ts";
import {
  fresherWorkflowRun,
  workflowFinishedCount,
  workflowHumanWait,
  workflowNodeDetail,
  workflowStatusLabel,
  workflowTimelineNodes,
} from "./workflowRun.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { Button, ChevronDownIcon, ChevronUpIcon, Spinner, StopIcon } from "../../../apps/web/src/components/ui/index.ts";

const needsHuman = (node: WorkflowRunNodeDto): boolean => workflowHumanWait(node) !== null;

function TimelineStatusIcon({ node }: { node: WorkflowRunNodeDto }) {
  if (node.status === "done") return <Icon.check />;
  if (node.status === "error") return <Icon.close />;
  if (node.status === "stopped") return <Icon.stop />;
  if (node.status === "skipped") return <Icon.branch />;
  if (node.status === "running") return <Spinner size="sm" />;
  return <Icon.clock />;
}

export default function WorkflowTimelineCard({ run }: { run: WorkflowRunDto }) {
  const [stopping, setStopping] = useState(false);
  const [apiRun, setApiRun] = useState<WorkflowRunDto | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openingSessionId, setOpeningSessionId] = useState("");
  useEffect(() => {
    setApiRun(null);
    setExpanded(false);
    setOpeningSessionId("");
  }, [run.id]);
  const shownRun = fresherWorkflowRun(apiRun, run) ?? run;
  const complete = workflowFinishedCount(shownRun);
  const waiting = shownRun.nodes.filter(needsHuman);
  const visibleWindow = workflowTimelineNodes(shownRun, expanded);
  const percent = shownRun.nodes.length ? Math.round((complete / shownRun.nodes.length) * 100) : 0;

  const stop = () => {
    if (stopping || shownRun.status !== "running") return;
    setStopping(true);
    void api.stopWorkflowRun(shownRun.id)
      .then((stopped) => {
        setApiRun(stopped);
        publishWorkflowRun(stopped);
      })
      .catch((cause) => setUiError(friendlyError(tr("workflowview.stopRun"), cause)))
      .finally(() => setStopping(false));
  };

  const openChildSession = async (sessionId: string) => {
    if (openingSessionId) return;
    setOpeningSessionId(sessionId);
    try {
      await openSession(sessionId);
    } catch (cause) {
      setUiError(friendlyError(tr("workflowview.openSession"), cause));
      setOpeningSessionId("");
    }
  };

  const viewWorkflow = () => {
    const projectId = shownRun.projectId ?? getState().activeProjectId;
    if (projectId) {
      handOffWorkflowLaunch({
        projectId,
        ...(shownRun.parentSessionId ? { sessionId: shownRun.parentSessionId } : {}),
        workflowId: shownRun.workflowId,
        input: shownRun.input,
        run: shownRun,
      });
    }
    openWorkspacePane("workflow");
  };

  return (
    <section
      className={`workflow-timeline-card status-${shownRun.status}`}
      aria-label={tr("workflowtimeline.valueLabel", {
        name: shownRun.name,
        status: workflowStatusLabel(shownRun.status),
      })}
    >
      <header>
        <span className="workflow-timeline-icon" aria-hidden="true"><Icon.workflow /></span>
        <span>
          <small>{tr("workflowtimeline.workflow")}</small>
          <strong>{shownRun.name}</strong>
        </span>
        <b className={`status-${shownRun.status}`} role="status" aria-live="polite">
          {workflowStatusLabel(shownRun.status)}
        </b>
      </header>
      <p title={shownRun.input}>{shownRun.input}</p>
      <div
        className="workflow-timeline-progress"
        role="progressbar"
        aria-label={tr("workflowtimeline.progress")}
        aria-valuemin={0}
        aria-valuemax={shownRun.nodes.length}
        aria-valuenow={complete}
        aria-valuetext={tr("workflowtimeline.nodesFinished", { complete, total: shownRun.nodes.length })}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="workflow-timeline-summary">
        <span>{tr("workflowtimeline.nodesFinished", { complete, total: shownRun.nodes.length })}</span>
        {waiting.length > 0 && (
          <strong>
            {tr(waiting.length === 1 ? "workflowtimeline.waitingOne" : "workflowtimeline.waitingOther", {
              count: waiting.length,
            })}
          </strong>
        )}
      </div>
      <ul aria-label={expanded ? tr("workflowtimeline.allNodes") : tr("workflowtimeline.focusedNodes")}>
        {visibleWindow.nodes.map((node) => (
          <li key={node.id} className={`status-${node.status}${needsHuman(node) ? " needs-human" : ""}`}>
            <span className="workflow-timeline-status-icon" aria-hidden="true">
              <TimelineStatusIcon node={node} />
            </span>
            <span>
              <strong>{node.role}</strong>
              <small title={workflowNodeDetail(node)}>{workflowNodeDetail(node)}</small>
            </span>
            {node.sessionId && (
              <Button
                size="sm"
                variant={needsHuman(node) ? "primary" : "quiet"}
                disabled={!!openingSessionId}
                busy={openingSessionId === node.sessionId}
                aria-label={needsHuman(node)
                  ? tr("workflowtimeline.reviewAndRespondValue", { role: node.role })
                  : tr("workflowtimeline.openChildValue", { role: node.role })}
                onClick={() => void openChildSession(node.sessionId!)}
              >
                {needsHuman(node)
                  ? tr("workflowtimeline.reviewAndRespond")
                  : tr("workflowtimeline.openSession")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {shownRun.nodes.length > 6 && (
        <div className="workflow-timeline-disclosure">
          <span className="workflow-timeline-range">
            {tr("workflowtimeline.nodeRange", {
              start: visibleWindow.start,
              end: visibleWindow.end,
              total: visibleWindow.total,
            })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="workflow-timeline-nodes-toggle"
            iconStart={expanded ? ChevronUpIcon : ChevronDownIcon}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? tr("workflowtimeline.showFocused")
              : tr("workflowtimeline.showAllValue", { count: shownRun.nodes.length })}
          </Button>
        </div>
      )}
      <footer>
        <Button
          size="sm"
          disabled={!!openingSessionId}
          onClick={viewWorkflow}
        >
          {tr("workflowtimeline.viewWorkflow")}
        </Button>
        {shownRun.status === "running" && (
          <Button
            size="sm"
            variant="danger"
            iconStart={StopIcon}
            busy={stopping}
            disabled={stopping}
            aria-label={tr("workflowtimeline.stopValue", { name: shownRun.name })}
            onClick={stop}
          >
            {tr("workflowtimeline.stopRun")}
          </Button>
        )}
      </footer>
    </section>
  );
}
