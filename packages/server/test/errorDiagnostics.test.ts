import assert from "node:assert/strict";
import { test } from "node:test";
import { httpErrorDiagnostics } from "../src/errorDiagnostics.ts";

test("diagnostics distinguish components and preserve request identity without exposing authority", () => {
  for (const [code, component] of [["auth-rejected", "auth"], ["storage-unavailable", "storage"], ["invalid-input", "validation"], ["validation", "validation"], ["native-failure", "provider"], ["harness-transport", "harness-transport"], ["http-500", "harness-transport"], ["protocol-response-invalid", "harness-transport"]]) {
    const result = httpErrorDiagnostics({ code, authorityId: "private", generation: 42 }, "POST", "request-one");
    assert.equal(result.component, component);
    assert.equal(result.requestId, "request-one");
    assert.equal("authorityId" in result, false);
  }
  assert.equal(httpErrorDiagnostics(new Error("fetch failed from storage"), "GET", "r").component, "server");
  const uncertain = httpErrorDiagnostics({ code: "outcome-unknown", mutationOutcome: "unknown", retryability: "safe" }, "POST", "r");
  assert.equal(uncertain.retryability, "never");
  assert.equal(uncertain.recovery, "none");
  assert.equal(httpErrorDiagnostics({ code: "http-409", mutationOutcome: "rejected" }, "POST", "r").mutationOutcome, "rejected");
});

test("an untagged mutation refusal is not-started, never a false outcome-unknown", () => {
  for (const code of ["not-found", "conflict", "draft-conflict", "history-mismatch", "worktree-dirty", "payload-too-large", "unsupported", "runtime-unavailable"]) {
    assert.equal(httpErrorDiagnostics({ code }, "POST", "r").mutationOutcome, "not-started", code);
  }
  // A genuinely uncertain failure keeps the conservative default.
  for (const code of ["internal", "outcome-unknown", "epoch-reset-unconfirmed", "harness-transport", "ENOENT"]) {
    assert.equal(httpErrorDiagnostics({ code }, "POST", "r").mutationOutcome, "unknown", code);
  }
  assert.equal(httpErrorDiagnostics({ code: "conflict", mutationOutcome: "unknown" }, "POST", "r").mutationOutcome, "unknown", "an explicit tag wins");
  assert.equal(httpErrorDiagnostics({ code: "conflict" }, "GET", "r").mutationOutcome, "not-applicable");
});
