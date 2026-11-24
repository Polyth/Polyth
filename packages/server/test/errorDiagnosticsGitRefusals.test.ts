import test from "node:test";
import assert from "node:assert/strict";
import { httpErrorDiagnostics } from "../src/errorDiagnostics.ts";

test("typed Git branch refusals are not-started on a mutation, never unknown", () => {
  for (const code of ["branch-in-use", "branch-exists", "branch-not-found", "invalid-branch-name", "session-busy", "worktree-dirty"]) {
    assert.equal(httpErrorDiagnostics({ code }, "POST", "r1").mutationOutcome, "not-started", code);
  }
  assert.equal(httpErrorDiagnostics({ code: "git-failed" }, "POST", "r1").mutationOutcome, "unknown", "other git failures keep their classification");
});
