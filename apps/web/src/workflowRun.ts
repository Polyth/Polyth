import type {
  WorkflowNodeStatus,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunStatus,
} from "@polyth/contracts";

export const WORKFLOW_STATUS_LABEL: Record<WorkflowNodeStatus | WorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Complete",
  error: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
};

export function workflowNodeFinished(node: WorkflowRunNodeDto): boolean {
  return node.status !== "queued" && node.status !== "running";
}

export function workflowFinishedCount(run: WorkflowRunDto): number {
  return run.nodes.filter(workflowNodeFinished).length;
}

export function workflowHumanWait(node: WorkflowRunNodeDto): "permission" | "answer" | null {
  if (node.status !== "running") return null;
  const activity = node.activity ?? "";
  if (/^awaiting permission(?::|$)/i.test(activity)) return "permission";
  if (/^awaiting answer(?::|$)/i.test(activity)) return "answer";
  return null;
}

export function workflowHumanWaitLabel(node: WorkflowRunNodeDto): string | null {
  const wait = workflowHumanWait(node);
  return wait === "permission"
    ? "Waiting for your approval"
    : wait === "answer"
      ? "Waiting for your answer"
      : null;
}

export function workflowNodeDetail(node: WorkflowRunNodeDto): string {
  return workflowHumanWaitLabel(node)
    ?? node.error
    ?? node.activity
    ?? (node.status === "queued" ? "Waiting for dependencies" : WORKFLOW_STATUS_LABEL[node.status]);
}

/**
 * Event-log state is normally the freshest source for a run. A terminal API
 * response wins over a still-running event projection during the short window
 * before its completion event arrives over WebSocket.
 */
export function fresherWorkflowRun(
  apiRun: WorkflowRunDto | null,
  eventRun: WorkflowRunDto | null,
): WorkflowRunDto | null {
  if (!apiRun) return eventRun;
  if (!eventRun) return apiRun;
  if (apiRun.id !== eventRun.id) {
    return eventRun.startedAt >= apiRun.startedAt ? eventRun : apiRun;
  }
  if (apiRun.status !== "running" && eventRun.status === "running") return apiRun;
  return eventRun;
}
