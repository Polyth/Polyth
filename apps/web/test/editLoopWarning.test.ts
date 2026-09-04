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
      kind: "file-oscillation",
      paths: ["a.ts", "b.ts"],
      signature: "file-oscillation:a.ts|b.ts",
      evidence: [{ tool: "edit", path: "a.ts", role: "edit" }],
    }),
  ]);
  assert.ok(model.editLoopWarning);
  assert.equal(model.editLoopWarning.kind, "file-oscillation");
  assert.deepEqual(model.editLoopWarning.paths, ["a.ts", "b.ts"]);
  assert.equal(model.editLoopWarning.signature, "file-oscillation:a.ts|b.ts");
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
