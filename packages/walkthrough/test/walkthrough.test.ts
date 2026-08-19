import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { decisionEventType, deriveWalkthrough, stepEventData, unifiedDiff } from "../src/index.ts";

function ev(seq: number, type: string, data: JsonObject): SessionEvent {
  return { id: `e${seq}`, sessionId: "s1", seq, time: 1000 + seq, type, data, v: 1 };
}

test("unifiedDiff returns empty string when text is unchanged", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
});

test("unifiedDiff produces a standard hunk for a small edit", () => {
  const diff = unifiedDiff("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n", "foo.txt");
  assert.ok(diff.startsWith("--- a/foo.txt\n+++ b/foo.txt\n"));
  assert.ok(diff.includes("@@ -1,3 +1,3 @@"));
  assert.ok(diff.includes("-line2"));
  assert.ok(diff.includes("+CHANGED"));
  assert.ok(diff.includes(" line1"));
  assert.ok(diff.includes(" line3"));
});

test("unifiedDiff treats a fresh write as an all-insert hunk", () => {
  const diff = unifiedDiff("", "hello\nworld\n", "new.txt");
  assert.ok(diff.includes("@@ -0,0 +1,2 @@"));
  assert.ok(diff.includes("+hello"));
  assert.ok(diff.includes("+world"));
});

test("unifiedDiff separates two distant changes into two hunks", () => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const newLines = [...oldLines];
  newLines[0] = "CHANGED0";
  newLines[19] = "CHANGED19";
  const diff = unifiedDiff(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`, "f");
  const hunkCount = diff.split("\n").filter((l) => l.startsWith("@@")).length;
  assert.equal(hunkCount, 2);
});

test("deriveWalkthrough ignores non-file tools and tools without a recognizable file", () => {
  const events: SessionEvent[] = [
    ev(1, "tool/result", { callId: "c1", tool: "bash", output: "ok", input: { command: "ls" } }),
    ev(2, "tool/result", { callId: "c2", tool: "edit", output: "ok", input: { oldString: "a", newString: "b" } }),
  ];
  assert.deepEqual(deriveWalkthrough(events), []);
});

test("deriveWalkthrough builds a pending step per file-editing tool result, in order", () => {
  const events: SessionEvent[] = [
    ev(1, "tool/result", { callId: "c1", tool: "edit", output: "ok", input: { filePath: "a.ts", oldString: "foo", newString: "bar" } }),
    ev(2, "tool/result", { callId: "c2", tool: "write", output: "ok", input: { filePath: "b.ts", content: "export const x = 1;\n" } }),
  ];
  const steps = deriveWalkthrough(events);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]!.file, "a.ts");
  assert.equal(steps[0]!.status, "pending");
  assert.ok(steps[0]!.diff.includes("-foo"));
  assert.ok(steps[0]!.diff.includes("+bar"));
  assert.equal(steps[1]!.file, "b.ts");
  assert.ok(steps[1]!.diff.includes("+export const x = 1;"));
});

test("deriveWalkthrough uses the tool result title as explanation when present", () => {
  const events: SessionEvent[] = [
    ev(1, "tool/result", {
      callId: "c1", tool: "edit", output: "ok", title: "src/a.ts (+1 -1)",
      input: { filePath: "src/a.ts", oldString: "x", newString: "y" },
    }),
  ];
  assert.equal(deriveWalkthrough(events)[0]!.explanation, "src/a.ts (+1 -1)");
});

test("deriveWalkthrough applies approve/reject overlay events by stepIndex", () => {
  const events: SessionEvent[] = [
    ev(1, "tool/result", { callId: "c1", tool: "edit", output: "ok", input: { filePath: "a.ts", oldString: "foo", newString: "bar" } }),
    ev(2, "tool/result", { callId: "c2", tool: "edit", output: "ok", input: { filePath: "b.ts", oldString: "foo", newString: "bar" } }),
    ev(3, "walkthrough/step-approved", stepEventData(0, { file: "a.ts", explanation: "", diff: "", status: "pending" })),
    ev(4, "walkthrough/step-rejected", stepEventData(1, { file: "b.ts", explanation: "", diff: "", status: "pending" })),
  ];
  const steps = deriveWalkthrough(events);
  assert.equal(steps[0]!.status, "approved");
  assert.equal(steps[1]!.status, "rejected");
});

test("decisionEventType maps status to the canonical event name", () => {
  assert.equal(decisionEventType("approved"), "walkthrough/step-approved");
  assert.equal(decisionEventType("rejected"), "walkthrough/step-rejected");
});

test("deriveWalkthrough skips a tool/result with an empty diff (e.g. no-op edit)", () => {
  const events: SessionEvent[] = [
    ev(1, "tool/result", { callId: "c1", tool: "edit", output: "ok", input: { filePath: "a.ts", oldString: "same", newString: "same" } }),
  ];
  assert.deepEqual(deriveWalkthrough(events), []);
});
