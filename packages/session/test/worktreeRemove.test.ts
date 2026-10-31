import { test } from "node:test";
import assert from "node:assert/strict";
import { errorChangesOf } from "../src/webApi.ts";

test("errorChangesOf reads the server-provided change count", () => {
  const dirty = Object.assign(new Error("dirty 3"), { code: "worktree-dirty", changes: 3 });
  assert.equal(errorChangesOf(dirty), 3);
  assert.equal(errorChangesOf(new Error("nope")), 0);
});
