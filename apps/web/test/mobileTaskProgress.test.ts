import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveTaskProgressEvent,
  taskProgressSnapshot,
  taskProgressSnapshotKey,
} from "../src/mobileTaskProgress.ts";

const task = (id: string, text: string, status: "pending" | "active" | "done" | "failed") => ({ id, text, status });

test("normalized task progress follows the newly active task instead of flashing the task it just completed", () => {
  const before = taskProgressSnapshot([
    task("a", "Collect repository state", "active"),
    task("b", "Check harnesses", "pending"),
  ]);
  const after = taskProgressSnapshot([
    task("a", "Collect repository state", "done"),
    task("b", "Check harnesses", "active"),
  ]);

  assert.deepEqual(deriveTaskProgressEvent(before, after), {
    kind: "active",
    key: "active:b:Check harnesses",
    text: "Check harnesses",
  });
});

test("completion is surfaced when no next task becomes active", () => {
  const before = taskProgressSnapshot([
    task("a", "Collect repository state", "active"),
    task("b", "Check harnesses", "pending"),
  ]);
  const after = taskProgressSnapshot([
    task("a", "Collect repository state", "done"),
    task("b", "Check harnesses", "pending"),
  ]);

  assert.equal(deriveTaskProgressEvent(before, after)?.kind, "completed");
});

test("all-complete and failure have explicit terminal cues", () => {
  const before = taskProgressSnapshot([
    task("a", "Collect repository state", "done"),
    task("b", "Check harnesses", "active"),
  ]);
  const done = taskProgressSnapshot([
    task("a", "Collect repository state", "done"),
    task("b", "Check harnesses", "done"),
  ]);
  assert.deepEqual(deriveTaskProgressEvent(before, done), {
    kind: "all-complete",
    key: `all-complete:${taskProgressSnapshotKey(done)}`,
    completed: 2,
    total: 2,
  });

  const failed = taskProgressSnapshot([
    task("a", "Collect repository state", "done"),
    task("b", "Check harnesses", "failed"),
  ]);
  assert.equal(deriveTaskProgressEvent(before, failed)?.kind, "failed");
});

test("replayed unchanged task state produces no title event", () => {
  const snapshot = taskProgressSnapshot([
    task("a", "Collect repository state", "done"),
    task("b", "Check harnesses", "active"),
  ]);
  assert.equal(deriveTaskProgressEvent(snapshot, snapshot), null);
});
