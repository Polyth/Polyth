/** Pure UI hand-off from Chat to the workflow settings: which template's
 * settings page to open. Runs belong to the chat that started them; the
 * window carries no run, request or route. */
export interface WorkflowLaunchIntent {
  projectId: string;
  workflowId?: string;
}

const STORAGE_KEY = "polyth.workflow-launch.v1";
const HANDOFF_EVENT = "polyth:workflow-launch-handoff";
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
    if (typeof value.projectId === "string") {
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
  // An already open workflow surface takes the intent now; a closed one takes
  // it when it mounts.
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(HANDOFF_EVENT));
}

export function subscribeWorkflowLaunches(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(HANDOFF_EVENT, listener);
  return () => window.removeEventListener(HANDOFF_EVENT, listener);
}

export function takeWorkflowLaunch(projectId: string): WorkflowLaunchIntent | null {
  const candidate = pending ?? storedIntent();
  if (candidate?.projectId !== projectId) return null;
  const intent = candidate;
  pending = null;
  try { storage()?.removeItem(STORAGE_KEY); } catch {}
  return structuredClone(intent);
}
