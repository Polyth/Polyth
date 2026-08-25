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

const STORAGE_KEY = "polyth.workflow-launch.v1";
let pending: WorkflowLaunchIntent | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function storedIntent(): WorkflowLaunchIntent | null {
  const target = storage();
  let raw: string | null = null;
  try {
    raw = target?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WorkflowLaunchIntent>;
    if (typeof value.projectId === "string" && typeof value.input === "string") {
      return value as WorkflowLaunchIntent;
    }
  } catch {
    // Invalid or obsolete data is removed below.
  }
  try { target?.removeItem(STORAGE_KEY); } catch {}
  return null;
}

export function handOffWorkflowLaunch(intent: WorkflowLaunchIntent): void {
  pending = structuredClone(intent);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // The in-memory hand-off still works when storage is disabled or full.
  }
}

export function takeWorkflowLaunch(projectId: string): WorkflowLaunchIntent | null {
  const candidate = pending ?? storedIntent();
  if (candidate?.projectId !== projectId) return null;
  const intent = candidate;
  pending = null;
  try { storage()?.removeItem(STORAGE_KEY); } catch {}
  return structuredClone(intent);
}
