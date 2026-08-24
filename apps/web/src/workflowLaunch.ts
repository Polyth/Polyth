import type { WorkflowRunDto } from "@polyth/contracts";

/** Pure UI hand-off from Chat to the workflow surface. The run itself and all
 * model-visible progress stay in the parent session event log. */
export interface WorkflowLaunchIntent {
  projectId: string;
  sessionId?: string;
  input: string;
  workflowId?: string;
  run?: WorkflowRunDto;
}

let pending: WorkflowLaunchIntent | null = null;

export function handOffWorkflowLaunch(intent: WorkflowLaunchIntent): void {
  pending = structuredClone(intent);
}

export function takeWorkflowLaunch(projectId: string): WorkflowLaunchIntent | null {
  if (pending?.projectId !== projectId) return null;
  const intent = pending;
  pending = null;
  return structuredClone(intent);
}
