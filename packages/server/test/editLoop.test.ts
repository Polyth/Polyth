import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import {
  detectEditLoop,
  EDIT_LOOP_OSCILLATION_CYCLES,
  EDIT_LOOP_SAME_FILE_EDITS,
  EDIT_LOOP_WINDOW,
  recentToolRecords,
  shouldEmitEditLoop,
  type ToolCallRecord,
} from "../src/editLoop.ts";

function record(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "tool">): ToolCallRecord {
  return {
    edit: false,
    check: false,
    failed: false,
    ...partial,
  };
}

function ev(seq: number, type: string, data: JsonObject): SessionEvent {
  return { sessionId: "s", seq, time: seq * 1000, type, data };
}

test("constants are exported and conservative", () => {
  assert.equal(EDIT_LOOP_WINDOW, 20);
  assert.equal(EDIT_LOOP_SAME_FILE_EDITS, 3);
  assert.equal(EDIT_LOOP_OSCILLATION_CYCLES, 3);
});

test("detects same-file edits interleaved with failing checks", () => {
  const records = [
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "bash", check: true, failed: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "bash", check: true, failed: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
  ];
  const hit = detectEditLoop(records);
  assert.ok(hit);
  assert.equal(hit.kind, "repeated-edit-with-failing-checks");
  assert.deepEqual(hit.paths, ["src/a.ts"]);
  assert.match(hit.signature, /repeated-edit/);
  assert.ok(hit.evidence.some((item) => item.failed));
});

test("does not fire for repeated edits of one file without failing checks", () => {
  const records = [
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "read", path: "src/a.ts" }),
  ];
  assert.equal(detectEditLoop(records), null);
});

test("does not fire for two edits plus one failing check", () => {
  const records = [
    record({ tool: "edit", path: "src/a.ts", edit: true }),
    record({ tool: "bash", check: true, failed: true }),
    record({ tool: "edit", path: "src/a.ts", edit: true }),
  ];
  assert.equal(detectEditLoop(records), null);
});

test("detects A↔B↔A oscillation over three cycles", () => {
  const records = [
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ];
  const hit = detectEditLoop(records);
  assert.ok(hit);
  assert.equal(hit.kind, "file-oscillation");
  assert.deepEqual(hit.paths, ["a.ts", "b.ts"]);
});

test("oscillation ignores consecutive same-path hunks", () => {
  const records = [
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }), // collapsed
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ];
  const hit = detectEditLoop(records);
  assert.ok(hit);
  assert.equal(hit.kind, "file-oscillation");
});

test("does not fire for short A↔B alternation", () => {
  const records = [
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ];
  // 2 cycles of A→B→A only (need 3)
  assert.equal(detectEditLoop(records), null);
});

test("does not fire for three distinct files", () => {
  const records = [
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "c.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "edit", path: "b.ts", edit: true }),
    record({ tool: "edit", path: "c.ts", edit: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ];
  assert.equal(detectEditLoop(records), null);
});

test("recentToolRecords extracts paths and failing bash checks from events", () => {
  const events = [
    ev(1, "user/message", { text: "fix" }),
    ev(2, "tool/result", {
      callId: "1",
      tool: "edit",
      output: "ok",
      input: { filePath: "src/a.ts", oldString: "x", newString: "y" },
    }),
    ev(3, "tool/result", {
      callId: "2",
      tool: "bash",
      output: "FAIL tests/a.test.ts",
      input: { command: "npm test" },
      metadata: { exitCode: 1 },
    }),
    ev(4, "tool/result", {
      callId: "3",
      tool: "edit",
      output: "ok",
      input: { filePath: "src/a.ts" },
    }),
    ev(5, "tool/error", {
      callId: "4",
      tool: "bash",
      error: "command failed",
      input: { command: "npm test" },
    }),
    ev(6, "tool/result", {
      callId: "5",
      tool: "edit",
      output: "ok",
      input: { path: "src/a.ts" },
    }),
  ];
  const records = recentToolRecords(events);
  assert.equal(records.length, 5);
  const hit = detectEditLoop(records);
  assert.ok(hit);
  assert.equal(hit.kind, "repeated-edit-with-failing-checks");
});

test("bare bash ls is not treated as a failing check", () => {
  const events = [
    ev(1, "tool/result", {
      callId: "1",
      tool: "edit",
      output: "ok",
      input: { filePath: "a.ts" },
    }),
    ev(2, "tool/result", {
      callId: "2",
      tool: "bash",
      output: "file not found",
      input: { command: "ls missing" },
      metadata: { exitCode: 2 },
    }),
    ev(3, "tool/result", {
      callId: "3",
      tool: "edit",
      output: "ok",
      input: { filePath: "a.ts" },
    }),
    ev(4, "tool/result", {
      callId: "4",
      tool: "bash",
      output: "file not found",
      input: { command: "ls missing" },
      metadata: { exitCode: 2 },
    }),
    ev(5, "tool/result", {
      callId: "5",
      tool: "edit",
      output: "ok",
      input: { filePath: "a.ts" },
    }),
  ];
  assert.equal(detectEditLoop(recentToolRecords(events)), null);
});

test("shouldEmitEditLoop dedupes same signature until pattern breaks", () => {
  const detection = detectEditLoop([
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "bash", check: true, failed: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
    record({ tool: "bash", check: true, failed: true }),
    record({ tool: "edit", path: "a.ts", edit: true }),
  ]);
  assert.ok(detection);
  const first = shouldEmitEditLoop(detection, undefined, 1_000);
  assert.equal(first.emit, true);
  const again = shouldEmitEditLoop(detection, first.next, 1_500);
  assert.equal(again.emit, false);
  const pastCooldown = shouldEmitEditLoop(detection, first.next, 1_000 + 120_000);
  assert.equal(pastCooldown.emit, false);
  const cleared = shouldEmitEditLoop(null, pastCooldown.next, 1_000 + 130_000);
  assert.equal(cleared.emit, false);
  assert.equal(cleared.next, undefined);
  const rearm = shouldEmitEditLoop(detection, cleared.next, 1_000 + 140_000);
  assert.equal(rearm.emit, true);
});
