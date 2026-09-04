import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, reduceEvent } from "../src/reduce.ts";

let seq = 0;
function ev(type: string, data: JsonObject): SessionEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId: "s",
    seq,
    time: seq * 1000,
    type,
    data,
    v: 1,
  };
}

test("runtime/edit-loop-detected reduces into editLoopWarning", () => {
  const model = buildModel([
    ev("runtime/edit-loop-detected", {
      kind: "repeated-edit-with-failing-checks",
      paths: ["src/a.ts"],
      signature: "repeated-edit-with-failing-checks:src/a.ts",
      evidence: [{ tool: "edit", path: "src/a.ts", role: "edit" }],
    }),
  ]);
  assert.ok(model.editLoopWarning);
  assert.equal(model.editLoopWarning.kind, "repeated-edit-with-failing-checks");
  assert.deepEqual(model.editLoopWarning.paths, ["src/a.ts"]);
});

test("user/message clears editLoopWarning", () => {
  let model = buildModel([
    ev("runtime/edit-loop-detected", {
      kind: "repeated-edit-with-failing-checks",
      paths: ["src/a.ts"],
      signature: "repeated-edit-with-failing-checks:src/a.ts",
      evidence: [],
    }),
  ]);
  assert.ok(model.editLoopWarning);
  model = reduceEvent(model, ev("user/message", { text: "continue" }));
  assert.equal(model.editLoopWarning, null);
});

test("ignores malformed edit-loop payloads", () => {
  const model = buildModel([
    ev("runtime/edit-loop-detected", { kind: "nope", paths: ["a.ts"] }),
  ]);
  assert.equal(model.editLoopWarning, null);
});
