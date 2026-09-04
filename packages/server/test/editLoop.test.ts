import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  clearEditLoopState,
  detectEditLoop,
  observeToolEvent,
  shouldEmitEditLoop,
  type ToolCallRecord,
} from "../src/editLoop.ts";

function record(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "tool">): ToolCallRecord {
  return {
    edit: false,
    failedCheck: false,
    ...partial,
  };
}

test("detects edit A → fail check → edit A → fail check → edit A", () => {
  const hit = detectEditLoop([
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "bash", failedCheck: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "bash", failedCheck: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
  ]);
  assert.ok(hit);
  assert.equal(hit.kind, "repeated-edit-with-failing-checks");
  assert.deepEqual(hit.paths, ["src/a.ts"]);
});

test("does not fire for repeated edits without failing checks", () => {
  assert.equal(detectEditLoop([
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
  ]), null);
});

test("does not fire for two edits plus one failing check", () => {
  assert.equal(detectEditLoop([
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "bash", failedCheck: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
  ]), null);
});

test("does not fire for A↔B file oscillation", () => {
  assert.equal(detectEditLoop([
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ]), null);
});

test("observeToolEvent uses a live ring and direct path fields only", () => {
  clearEditLoopState();
  const sid = "s1";
  const push = (ev: RuntimeEvent) => observeToolEvent(sid, ev);

  assert.equal(push({
    type: "tool/result",
    callId: "1",
    tool: "edit",
    output: "ok",
    input: { filePath: "src/a.ts", nested: { path: "ignored.ts" } },
  }), null);

  assert.equal(push({
    type: "tool/result",
    callId: "2",
    tool: "bash",
    output: "fail",
    input: { command: "npm test" },
    metadata: { exitCode: 1 },
  }), null);

  assert.equal(push({
    type: "tool/result",
    callId: "3",
    tool: "edit",
    output: "ok",
    input: { path: "src/a.ts" },
  }), null);

  assert.equal(push({
    type: "tool/error",
    callId: "4",
    tool: "bash",
    error: "failed",
    input: { command: "npm test" },
  }), null);

  const hit = push({
    type: "tool/result",
    callId: "5",
    tool: "edit",
    output: "ok",
    input: { file: "src/a.ts" },
  });
  assert.ok(hit);
  assert.equal(hit.kind, "repeated-edit-with-failing-checks");
});

test("bare bash ls failure is not a check between edits", () => {
  clearEditLoopState("s2");
  const sid = "s2";
  for (let i = 0; i < 3; i += 1) {
    observeToolEvent(sid, {
      type: "tool/result",
      callId: `e${i}`,
      tool: "edit",
      output: "ok",
      input: { filePath: "a.ts" },
    });
    if (i < 2) {
      observeToolEvent(sid, {
        type: "tool/result",
        callId: `b${i}`,
        tool: "bash",
        output: "missing",
        input: { command: "ls missing" },
        metadata: { exitCode: 2 },
      });
    }
  }
  assert.equal(observeToolEvent(sid, {
    type: "tool/result",
    callId: "noop",
    tool: "read",
    output: "x",
  }), null);
});

test("shouldEmitEditLoop dedupes until the pattern breaks", () => {
  const detection = detectEditLoop([
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "bash", failedCheck: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "bash", failedCheck: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ]);
  assert.ok(detection);
  const first = shouldEmitEditLoop(detection, undefined, 1_000);
  assert.equal(first.emit, true);
  assert.equal(shouldEmitEditLoop(detection, first.next, 1_500).emit, false);
  assert.equal(shouldEmitEditLoop(detection, first.next, 120_000).emit, false);
  const cleared = shouldEmitEditLoop(null, first.next, 130_000);
  assert.equal(cleared.next, undefined);
  assert.equal(shouldEmitEditLoop(detection, cleared.next, 140_000).emit, true);
});
