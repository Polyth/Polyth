import { useEffect, useState } from "react";
import type { WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { openSession } from "../init.ts";
import { Icon } from "../icons.tsx";
import { getState, setActiveView, setUiError } from "../store.ts";
import { handOffWorkflowLaunch } from "../workflowLaunch.ts";
import { friendlyError } from "../settings.ts";
import {
  WORKFLOW_STATUS_LABEL,
  fresherWorkflowRun,
  workflowFinishedCount,
  workflowHumanWait,
  workflowNodeDetail,
} from "../workflowRun.ts";

const needsHuman = (node: WorkflowRunNodeDto): boolean => workflowHumanWait(node) !== null;

export default function WorkflowTimelineCard({ run }: { run: WorkflowRunDto }) {
  const [stopping, setStopping] = useState(false);
  const [apiRun, setApiRun] = useState<WorkflowRunDto | null>(null);
  useEffect(() => setApiRun(null), [run.id]);
  const shownRun = fresherWorkflowRun(apiRun, run) ?? run;
  const complete = workflowFinishedCount(shownRun);
  const waiting = shownRun.nodes.filter(needsHuman);
  const percent = shownRun.nodes.length ? Math.round((complete / shownRun.nodes.length) * 100) : 0;

  const stop = () => {
    if (stopping || shownRun.status !== "running") return;
    setStopping(true);
    void api.stopWorkflowRun(shownRun.id)
      .then(setApiRun)
      .catch((cause) => setUiError(friendlyError("Couldn’t stop the workflow", cause)))
      .finally(() => setStopping(false));
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
    setActiveView("workflow");
  };

  return (
    <section className={`workflow-timeline-card status-${shownRun.status}`} aria-label={`Workflow ${shownRun.name}, ${WORKFLOW_STATUS_LABEL[shownRun.status]}`}>
      <header>
        <span className="workflow-timeline-icon" aria-hidden="true"><Icon.workflow /></span>
        <span>
          <small>Workflow</small>
          <strong>{shownRun.name}</strong>
        </span>
        <b className={`status-${shownRun.status}`} role="status" aria-live="polite">
          {WORKFLOW_STATUS_LABEL[shownRun.status]}
        </b>
      </header>
      <p title={shownRun.input}>{shownRun.input}</p>
      <div
        className="workflow-timeline-progress"
        role="progressbar"
        aria-label="Workflow progress"
        aria-valuemin={0}
        aria-valuemax={shownRun.nodes.length}
        aria-valuenow={complete}
        aria-valuetext={`${complete} of ${shownRun.nodes.length} nodes finished`}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="workflow-timeline-summary">
        <span>{complete}/{shownRun.nodes.length} nodes finished</span>
        {waiting.length > 0 && <strong>{waiting.length} waiting for you</strong>}
      </div>
      <ul>
        {shownRun.nodes.map((node) => (
          <li key={node.id} className={`status-${node.status}${needsHuman(node) ? " needs-human" : ""}`}>
            <span aria-hidden="true">
              {node.status === "done" ? "✓" : node.status === "error" ? "×" : node.status === "running" ? "●" : "○"}
            </span>
            <span>
              <strong>{node.role}</strong>
              <small title={workflowNodeDetail(node)}>{workflowNodeDetail(node)}</small>
            </span>
            {node.sessionId && (
              <button
                type="button"
                className={`small-btn workflow-button${needsHuman(node) ? " primary-btn" : ""}`}
                aria-label={`${needsHuman(node) ? "Review and respond in" : "Open"} ${node.role} child session`}
                onClick={() => void openSession(node.sessionId!)}
              >
                {needsHuman(node) ? "Review & respond" : "Open session"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <footer>
        <button type="button" className="small-btn workflow-button" onClick={viewWorkflow}>
          View workflow
        </button>
        {shownRun.status === "running" && (
          <button
            type="button"
            className="small-btn danger-btn workflow-button"
            disabled={stopping}
            aria-busy={stopping}
            aria-label={`Stop ${shownRun.name} workflow run`}
            onClick={stop}
          >
            <Icon.stop />{stopping ? "Stopping…" : "Stop run"}
          </button>
        )}
      </footer>
    </section>
  );
}
