import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import {
  clampStep, deriveReplay, lastTurnRange, looksBinary, relativizeDiffHeaders, replayDisplayPath, replayIntervalMs, replayKeyAction,
  scopeReplay, timelineByFile,
} from "../src/index.ts";

const ev = (seq: number, type: string, data: JsonObject): SessionEvent =>
  ({ id: `e${seq}`, sessionId: "s1", seq, time: 1000 + seq, type, data, v: 1 });
const tool = (seq: number, name: string, input: JsonObject) => ev(seq, "tool/result", { callId: `c${seq}`, tool: name, output: "ok", input });

const log: SessionEvent[] = [
  ev(1, "user/message", { text: "first" }),
  tool(2, "write", { filePath: "a.ts", content: "one\ntwo\n" }),
  ev(3, "user/message", { text: "second" }),
  tool(4, "edit", { filePath: "a.ts", oldString: "two", newString: "TWO" }),
  tool(5, "edit", { filePath: "b.ts", oldString: "x", newString: "y" }),
  ev(6, "user/message", { text: "auto", autoResume: true }),
  tool(7, "write", { filePath: "b.ts", content: "fresh\n" }),
];

test("deriveReplay rebuilds before/after file state by folding the log", () => {
  const { steps, turnCount } = deriveReplay(log);
  assert.equal(turnCount, 2); // hidden auto-resume prompt doesn't open a turn
  assert.deepEqual(steps.map((s) => s.turn), [0, 1, 1, 1]);
  assert.equal(steps[0]!.before, null);
  assert.deepEqual(steps[0]!.after, { text: "one\ntwo\n", complete: true });
  assert.deepEqual(steps[1]!.before, { text: "one\ntwo\n", complete: true });
  assert.deepEqual(steps[1]!.after, { text: "one\nTWO\n", complete: true });
  assert.equal(steps[1]!.messageSeq, 3);
  // unseen base → only the snippet is known and says so
  assert.deepEqual(steps[2]!.after, { text: "y", complete: false });
  assert.equal(steps[2]!.before?.complete, false);
  // write over a base we could not trust: no fabricated before
  assert.equal(steps[3]!.before, null);
  assert.ok(steps[3]!.diff.includes("+fresh"));
});

test("deriveReplay is deterministic and skips non-file/empty-diff events", () => {
  const noisy = [...log, tool(8, "bash", { command: "ls" }), tool(9, "edit", { filePath: "a.ts", oldString: "q", newString: "q" })];
  assert.deepEqual(deriveReplay(noisy), deriveReplay(noisy));
  assert.equal(deriveReplay(noisy).steps.length, 4);
});

test("lastTurnRange scopes to the last turn that changed files", () => {
  const model = deriveReplay([...log, ev(8, "user/message", { text: "chat only" })]);
  assert.deepEqual(lastTurnRange(model), { fromTurn: 1, toTurn: 1 });
  assert.equal(scopeReplay(model.steps, lastTurnRange(model)).length, 3);
  assert.equal(scopeReplay(model.steps, { fromTurn: 1, toTurn: 0 }).length, 4);
  assert.deepEqual(lastTurnRange({ steps: [], turnCount: 0 }), { fromTurn: 0, toTurn: 0 });
});

test("per-file filter and timeline grouping", () => {
  const { steps } = deriveReplay(log);
  const onlyB = scopeReplay(steps, { fromTurn: 0, toTurn: 1 }, new Set(["b.ts"]));
  assert.deepEqual(onlyB.map((s) => s.file), ["b.ts", "b.ts"]);
  assert.deepEqual(timelineByFile(steps), [
    { file: "a.ts", positions: [0, 1] }, { file: "b.ts", positions: [2, 3] },
  ]);
});

test("cursor, keys and speed helpers", () => {
  assert.equal(clampStep(9, 3), 2);
  assert.equal(clampStep(-4, 3), 0);
  assert.equal(clampStep(NaN, 3), 0);
  assert.equal(clampStep(1, 0), 0);
  assert.equal(replayKeyAction(" "), "toggle");
  assert.equal(replayKeyAction("ArrowRight"), "next");
  assert.equal(replayKeyAction("ArrowRight", { meta: true }), undefined);
  assert.equal(replayKeyAction("x"), undefined);
  assert.ok(replayIntervalMs(4) < replayIntervalMs(1));
});

test("looksBinary flags NUL/control-heavy text but not ordinary source", () => {
  assert.equal(looksBinary("\u0089PNG\r\n\u001a\n\u0000\u0000IHDR"), true);
  assert.equal(looksBinary("const a = 1;\n\tfoo();\r\n"), false);
  assert.equal(looksBinary(""), false);
});

test("paths display workspace-relative with single separators", () => {
  const roots = ["/data/projects/demo/", "/data/projects/demo/.polyth/worktrees/w1"];
  assert.equal(replayDisplayPath("/data/projects/demo/src/math.js", roots), "src/math.js");
  assert.equal(replayDisplayPath("/data/projects/demo/.polyth/worktrees/w1/src/a.ts", roots), "src/a.ts", "longest root wins");
  assert.equal(replayDisplayPath("/data/projects/demo//src\\b.ts", roots), "src/b.ts");
  assert.equal(replayDisplayPath("/data/projects/demo-other/x.ts", roots), "/data/projects/demo-other/x.ts", "a sibling prefix is not a root");
  assert.equal(replayDisplayPath("src/rel.ts", roots), "src/rel.ts");
  assert.equal(replayDisplayPath("/etc/hosts"), "/etc/hosts");

  assert.equal(
    relativizeDiffHeaders("--- a//data/projects/demo/src/m.js\n+++ b//data/projects/demo/src/m.js\n@@ -1 +1 @@\n-x\n+y", roots),
    "--- a/src/m.js\n+++ b/src/m.js\n@@ -1 +1 @@\n-x\n+y",
  );
  assert.equal(relativizeDiffHeaders("--- /dev/null\n+++ /data/projects/demo/n.ts", roots), "--- /dev/null\n+++ b/n.ts");
  assert.equal(relativizeDiffHeaders("--- a//etc/hosts", roots), "--- a/etc/hosts", "outside every root: no doubled slash");
});

test("derived steps, diffs and titles use workspace-relative paths", () => {
  const root = "/data/projects/demo";
  const { steps } = deriveReplay([
    ev(1, "user/message", { text: "go" }),
    tool(2, "write", { filePath: `${root}/src/math.js`, content: "a\n" }),
    ev(3, "tool/result", { callId: "c3", tool: "edit", title: `Edit ${root}/src/math.js`, output: "ok",
      input: { filePath: `${root}/src/math.js`, oldString: "a", newString: "b" } }),
    tool(4, "write", { filePath: "/tmp/out.txt", content: "z\n" }),
  ], { roots: [root] });
  assert.deepEqual(steps.map((s) => s.file), ["src/math.js", "src/math.js", "/tmp/out.txt"]);
  assert.match(steps[0]!.diff, /^--- \/dev\/null\n\+\+\+ b\/src\/math\.js$/m);
  assert.equal(steps[0]!.explanation, "Write src/math.js");
  assert.equal(steps[1]!.explanation, "Edit src/math.js");
  assert.equal(steps[1]!.before?.complete, true, "relative keys still chain file state");
  assert.match(steps[2]!.diff, /^\+\+\+ b\/tmp\/out\.txt$/m);
  assert.doesNotMatch(steps.map((s) => s.diff).join("\n"), /[ab]\/\//);
});
