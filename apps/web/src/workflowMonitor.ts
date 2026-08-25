import type { WorkflowRunDto } from "@polyth/contracts";

const WORKFLOW_RUN_UPDATED = "polyth:workflow-run-updated";

/** Pure UI invalidation. Durable workflow state remains in the parent event
 * log; this closes the short gap before WebSocket delivery or the next poll. */
export function publishWorkflowRun(run: WorkflowRunDto): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkflowRunDto>(WORKFLOW_RUN_UPDATED, {
    detail: structuredClone(run),
  }));
}

export function subscribeWorkflowRuns(listener: (run: WorkflowRunDto) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event) => {
    const run = (event as CustomEvent<WorkflowRunDto>).detail;
    if (run && typeof run.id === "string") listener(run);
  };
  window.addEventListener(WORKFLOW_RUN_UPDATED, handle);
  return () => window.removeEventListener(WORKFLOW_RUN_UPDATED, handle);
}
