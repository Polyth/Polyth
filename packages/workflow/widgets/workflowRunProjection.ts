// Canonical workflow events → the run the timeline card shows. The card is
// anchored at its `workflow/run-started` event, so the package folds that
// session's own workflow events itself instead of asking the shell to project
// a workflow-specific run model. Pure and replay-deterministic.
import type {
  SessionEvent,
  WorkflowRunCompletedData,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunStartedData,
} from "@polyth/contracts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function startedRun(data: WorkflowRunStartedData): WorkflowRunDto {
  return {
    id: data.runId,
    workflowId: data.workflowId,
    ...(data.projectId ? { projectId: data.projectId } : {}),
    ...(data.parentSessionId ? { parentSessionId: data.parentSessionId } : {}),
    name: data.name,
    input: data.input,
    ...(data.clientOperationId ? { clientOperationId: data.clientOperationId } : {}),
    ...(data.retryOf ? { retryOf: data.retryOf } : {}),
    ...(data.context ? { context: data.context } : {}),
    ...(data.definition ? { definition: data.definition } : {}),
    ...(data.options ? { options: data.options } : {}),
    status: "running",
    startedAt: typeof data.startedAt === "number" ? data.startedAt : 0,
    layers: (data.layers ?? []).map((layer) => [...layer]),
    nodes: (data.nodes ?? []).map((node) => ({ ...node })),
  };
}

/** Mirror of the shell reducer's partial-node merge: `null` clears a field and
 *  `outputDelta` extends the streamed output. */
function applyNodeProgress(run: WorkflowRunDto, raw: Record<string, unknown>): void {
  const nodeId = typeof raw.nodeId === "string" ? raw.nodeId : undefined;
  const node = raw.node && typeof raw.node === "object" ? raw.node as Record<string, unknown> : undefined;
  if (!node || !nodeId) return;
  const index = run.nodes.findIndex((entry) => entry.id === nodeId);
  if (raw.partial !== true) {
    const snapshot = { ...node } as unknown as WorkflowRunNodeDto;
    if (index === -1) run.nodes.push(snapshot);
    else run.nodes[index] = snapshot;
    return;
  }
  const current: Record<string, unknown> = index === -1 ? { id: nodeId, role: "" } : { ...run.nodes[index]! };
  for (const [key, value] of Object.entries(node)) {
    if (value === null) delete current[key];
    else current[key] = value;
  }
  if (typeof raw.outputDelta === "string") {
    current.output = (typeof current.output === "string" ? current.output : "") + raw.outputDelta;
  }
  const merged = current as unknown as WorkflowRunNodeDto;
  if (index === -1) run.nodes.push(merged);
  else run.nodes[index] = merged;
}

function applyRunCompleted(run: WorkflowRunDto, data: WorkflowRunCompletedData, at: number): void {
  if (data.status === "done" || data.status === "error" || data.status === "stopped") run.status = data.status;
  run.finishedAt = typeof data.finishedAt === "number" ? data.finishedAt : at;
  if (typeof data.result === "string") run.result = data.result;
  if (typeof data.interrupted === "boolean") run.interrupted = data.interrupted;
}

/**
 * The latest state of the run whose `workflow/run-started` anchor is `event`,
 * folded from the session's canonical events from that anchor forward. Returns
 * null for anything but a run start.
 */
export function workflowRunFromStartedEvent(
  event: SessionEvent,
  events: readonly SessionEvent[],
): WorkflowRunDto | null {
  if (event.type !== "workflow/run-started") return null;
  const started = event.data as unknown as WorkflowRunStartedData;
  if (typeof started.runId !== "string") return null;
  const run = startedRun(started);
  for (const later of events) {
    if (later.seq <= event.seq) continue;
    if (later.type === "workflow/run-started") {
      const data = later.data as unknown as WorkflowRunStartedData;
      if (data.runId === run.id) Object.assign(run, startedRun(data));
    } else if (later.type === "workflow/node-progress") {
      const raw = asRecord(later.data);
      if (raw.runId !== run.id) continue;
      applyNodeProgress(run, raw);
    } else if (later.type === "workflow/run-completed") {
      const data = later.data as unknown as WorkflowRunCompletedData;
      if (data.runId !== run.id) continue;
      applyRunCompleted(run, data, later.time);
    }
  }
  return run;
}
