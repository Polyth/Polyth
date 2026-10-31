import type { IslandTask } from "./mobileIsland.ts";

export type TaskProgressStatus = IslandTask["status"];

export interface TaskProgressSnapshotItem {
  id: string;
  text: string;
  status: TaskProgressStatus;
}

export type TaskProgressEvent =
  | { kind: "active"; key: string; text: string }
  | { kind: "completed"; key: string; text: string }
  | { kind: "failed"; key: string; text: string }
  | { kind: "all-complete"; key: string; completed: number; total: number };

export function taskProgressSnapshot(tasks: readonly IslandTask[]): TaskProgressSnapshotItem[] {
  return tasks.map((task) => ({ id: task.id, text: task.text, status: task.status }));
}

export function taskProgressSnapshotKey(tasks: readonly TaskProgressSnapshotItem[]): string {
  return tasks.map((task) => `${task.id}:${task.status}:${task.text}`).join("\u001f");
}

/**
 * Choose the one task transition worth borrowing the compact phone title for.
 * Failure wins. A newly active task wins over the completion that promoted it,
 * so a TodoWrite snapshot that flips A→done and B→active never flashes stale A
 * before showing what the agent is actually doing now.
 */
export function deriveTaskProgressEvent(
  previous: readonly TaskProgressSnapshotItem[],
  current: readonly TaskProgressSnapshotItem[],
): TaskProgressEvent | null {
  if (current.length === 0) return null;
  const before = new Map(previous.map((task) => [task.id, task]));

  const failed = current.find((task) =>
    task.status === "failed" && before.get(task.id)?.status !== "failed");
  if (failed) {
    return { kind: "failed", key: `failed:${failed.id}:${failed.text}`, text: failed.text };
  }

  const previousActive = previous.find((task) => task.status === "active");
  const active = current.find((task) => task.status === "active");
  if (active) {
    const old = before.get(active.id);
    if (previousActive?.id !== active.id || old?.status !== "active" || old.text !== active.text) {
      return { kind: "active", key: `active:${active.id}:${active.text}`, text: active.text };
    }
  }

  const allComplete = current.every((task) => task.status === "done");
  const wasAllComplete = previous.length > 0 && previous.every((task) => task.status === "done");
  if (allComplete && !wasAllComplete) {
    return {
      kind: "all-complete",
      key: `all-complete:${taskProgressSnapshotKey(current)}`,
      completed: current.length,
      total: current.length,
    };
  }

  const completed = current.find((task) =>
    task.status === "done" && before.get(task.id)?.status !== "done");
  if (completed) {
    return { kind: "completed", key: `completed:${completed.id}:${completed.text}`, text: completed.text };
  }

  return null;
}
