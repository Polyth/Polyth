import { useState } from "react";
import type { WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { openSession } from "../init.ts";
import { Icon } from "../icons.tsx";
import { getState, setActiveView, setUiError } from "../store.ts";
import { handOffWorkflowLaunch } from "../workflowLaunch.ts";
import {
  WORKFLOW_STATUS_LABEL,
  workflowFinishedCount,
  workflowHumanWait,
  workflowNodeDetail,
} from "../workflowRun.ts";

const needsHuman = (node: WorkflowRunNodeDto): boolean => workflowHumanWait(node) !== null;

export default function WorkflowTimelineCard({ run }: { run: WorkflowRunDto }) {
  const [stopping, setStopping] = useState(false);
  const complete = workflowFinishedCount(run);
  const waiting = run.nodes.filter(needsHuman);
  const percent = run.nodes.length ? Math.round((complete / run.nodes.length) * 100) : 0;

  const stop = () => {
    if (stopping || run.status !== "running") return;
    setStopping(true);
    void api.stopWorkflowRun(run.id)
      .catch((cause) => setUiError(`Couldn’t stop workflow: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => setStopping(false));
  };

  const viewWorkflow = () => {
    const projectId = run.projectId ?? getState().activeProjectId;
    if (projectId) {
      handOffWorkflowLaunch({
        projectId,
        ...(run.parentSessionId ? { sessionId: run.parentSessionId } : {}),
        workflowId: run.workflowId,
        input: run.input,
        run,
      });
    }
    setActiveView("workflow");
  };

  return (
    <section className={`workflow-timeline-card status-${run.status}`} aria-label={`Workflow ${run.name}, ${WORKFLOW_STATUS_LABEL[run.status]}`}>
      <header>
        <span className="workflow-timeline-icon" aria-hidden="true"><Icon.workflow /></span>
        <span>
          <small>Workflow</small>
          <strong>{run.name}</strong>
        </span>
        <b className={`status-${run.status}`} role="status" aria-live="polite">
          {WORKFLOW_STATUS_LABEL[run.status]}
        </b>
      </header>
      <p title={run.input}>{run.input}</p>
      <div
        className="workflow-timeline-progress"
        role="progressbar"
        aria-label="Workflow progress"
        aria-valuemin={0}
        aria-valuemax={run.nodes.length}
        aria-valuenow={complete}
        aria-valuetext={`${complete} of ${run.nodes.length} nodes finished`}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="workflow-timeline-summary">
        <span>{complete}/{run.nodes.length} nodes finished</span>
        {waiting.length > 0 && <strong>{waiting.length} waiting for you</strong>}
      </div>
      <ul>
        {run.nodes.map((node) => (
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
        {run.status === "running" && (
          <button
            type="button"
            className="small-btn danger-btn workflow-button"
            disabled={stopping}
            aria-busy={stopping}
            onClick={stop}
          >
            <Icon.stop />{stopping ? "Stopping…" : "Stop run"}
          </button>
        )}
      </footer>
    </section>
  );
}
