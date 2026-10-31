import { useSyncExternalStore } from "react";
import type { WorkflowRunDto } from "@polyth/contracts";
import { publishWorkflowRun } from "./workflowMonitor.ts";

/** A run the client asked to start in a fresh parent session that the server
 * has not admitted yet. Pure UI: the admitted run and all of its progress live
 * in the parent session's event log; this only covers the gap between Run and
 * admission so the workflow window can show the launch the moment it opens. */
export interface WorkflowStart {
  parentSessionId: string;
  projectId: string;
  workflowId: string;
  input: string;
  status: "starting" | "failed";
  error?: string;
}

interface Entry {
  start: WorkflowStart;
  /** Re-sends the exact same request, including its client operation id, so a
   * retry after a lost response can never admit a second run. */
  attempt: () => Promise<WorkflowRunDto>;
  describe: (cause: unknown) => string;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function update(entry: Entry, patch: Pick<WorkflowStart, "status"> & { error?: string }): void {
  const { error: _previous, ...rest } = entry.start;
  entry.start = { ...rest, ...patch };
  emit();
}

async function execute(entry: Entry): Promise<WorkflowRunDto> {
  try {
    const run = await entry.attempt();
    if (entries.get(entry.start.parentSessionId) === entry) {
      entries.delete(entry.start.parentSessionId);
      emit();
    }
    publishWorkflowRun(run);
    return run;
  } catch (cause) {
    if (entries.get(entry.start.parentSessionId) === entry) {
      update(entry, { status: "failed", error: entry.describe(cause) });
    }
    throw cause;
  }
}

/** Track and send a start request. Resolves with the admitted run; rejects
 * with the request's error, which also stays visible on the tracked start. */
export function beginWorkflowStart(
  start: Omit<WorkflowStart, "status" | "error">,
  attempt: () => Promise<WorkflowRunDto>,
  describe: (cause: unknown) => string,
): Promise<WorkflowRunDto> {
  const entry: Entry = { start: { ...start, status: "starting" }, attempt, describe };
  entries.set(start.parentSessionId, entry);
  emit();
  return execute(entry);
}

/** Retry a failed start with its original request. */
export function retryWorkflowStart(parentSessionId: string): Promise<WorkflowRunDto> | null {
  const entry = entries.get(parentSessionId);
  if (!entry || entry.start.status !== "failed") return null;
  update(entry, { status: "starting" });
  return execute(entry);
}

export function dismissWorkflowStart(parentSessionId: string): void {
  if (entries.delete(parentSessionId)) emit();
}

export function workflowStartFor(parentSessionId: string | null | undefined): WorkflowStart | undefined {
  return parentSessionId ? entries.get(parentSessionId)?.start : undefined;
}

export function subscribeWorkflowStarts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useWorkflowStart(parentSessionId: string | null | undefined): WorkflowStart | undefined {
  return useSyncExternalStore(
    subscribeWorkflowStarts,
    () => workflowStartFor(parentSessionId),
    () => undefined,
  );
}
