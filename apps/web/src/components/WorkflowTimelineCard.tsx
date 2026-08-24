import { useState } from "react";
import type { WorkflowRunDto, WorkflowRunNodeDto } from "@polyth/contracts";
import { api } from "../api.ts";
import { openSession } from "../init.ts";
import { Icon } from "../icons.tsx";
import { setActiveView, setUiError } from "../store.ts";

const finished = (node: WorkflowRunNodeDto): boolean =>
  node.status !== "queued" && node.status !== "running";

const needsHuman = (node: WorkflowRunNodeDto): boolean =>
  node.status === "running" && /awaiting (permission|answer)/i.test(node.activity ?? "");

export default function WorkflowTimelineCard({ run }: { run: WorkflowRunDto }) {
  const [stopping, setStopping] = useState(false);
  const complete = run.nodes.filter(finished).length;
  const waiting = run.nodes.filter(needsHuman);
  const percent = run.nodes.length ? Math.round((complete / run.nodes.length) * 100) : 0;

  const stop = () => {
    if (stopping || run.status !== "running") return;
    setStopping(true);
    void api.stopWorkflowRun(run.id)
      .catch((cause) => setUiError(`Couldn’t stop workflow: ${cause instanceof Error ? cause.message : String(cause)}`))
      .finally(() => setStopping(false));
  };

  return (
    <section className={`workflow-timeline-card status-${run.status}`} aria-label={`Workflow ${run.name}, ${run.status}`}>
      <header>
        <span className="workflow-timeline-icon" aria-hidden="true"><Icon.workflow /></span>
        <span>
          <small>Workflow</small>
          <strong>{run.name}</strong>
        </span>
        <b>{run.status === "running" ? "Running" : run.status === "done" ? "Complete" : run.status === "error" ? "Failed" : "Stopped"}</b>
      </header>
      <p>{run.input}</p>
      <div className="workflow-timeline-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.nodes.length} aria-valuenow={complete}>
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
              <small>{needsHuman(node) ? "Waiting for your approval" : node.error ?? node.activity ?? node.status}</small>
            </span>
            {node.sessionId && needsHuman(node) && (
              <button type="button" className="small-btn" onClick={() => void openSession(node.sessionId!)}>
                Review &amp; respond
              </button>
            )}
          </li>
        ))}
      </ul>
      <footer>
        <button type="button" className="small-btn" onClick={() => setActiveView("workflow")}>
          View workflow
        </button>
        {run.status === "running" && (
          <button type="button" className="small-btn danger-btn" disabled={stopping} onClick={stop}>
            <Icon.stop />{stopping ? "Stopping…" : "Stop run"}
          </button>
        )}
      </footer>
    </section>
  );
}
