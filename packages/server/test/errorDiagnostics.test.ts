import assert from "node:assert/strict";
import { test } from "node:test";
import { httpErrorDiagnostics, lifecyclePassError } from "../src/errorDiagnostics.ts";

test("opening or warming a chat never reports an unknown outcome, and a shared error keeps its own tags", () => {
  // 2026-11-26: opening an archived chat answered 409 `epoch-pending`, which
  // the phone showed as "it may have worked anyway".
  const cached = Object.assign(new Error("backend session creation outcome is unknown"), { code: "outcome-unknown", mutationOutcome: "unknown" });
  for (const error of [Object.assign(new Error("runtime replacement is pending"), { code: "epoch-pending" }), cached, new Error("boom")]) {
    const passed = lifecyclePassError(error) as Error & { code?: string };
    const diagnostics = httpErrorDiagnostics(passed, "POST", "r");
    assert.equal(diagnostics.mutationOutcome, "not-applicable");
    assert.equal(diagnostics.retryability, "safe");
    assert.equal(passed.message, error.message);
    assert.equal(passed.code, (error as { code?: string }).code);
    assert.equal(passed.cause, error);
  }
  assert.equal(cached.mutationOutcome, "unknown", "the send path rethrowing a cached failure still reports it");
  assert.equal(lifecyclePassError("plain"), "plain");
});

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
  for (const code of ["not-found", "conflict", "draft-conflict", "history-mismatch", "worktree-dirty", "payload-too-large", "unsupported", "runtime-unavailable", "unavailable-in-edition"]) {
    assert.equal(httpErrorDiagnostics({ code }, "POST", "r").mutationOutcome, "not-started", code);
  }
  // A genuinely uncertain failure keeps the conservative default.
  for (const code of ["internal", "outcome-unknown", "epoch-reset-unconfirmed", "harness-transport", "ENOENT"]) {
    assert.equal(httpErrorDiagnostics({ code }, "POST", "r").mutationOutcome, "unknown", code);
  }
  assert.equal(httpErrorDiagnostics({ code: "conflict", mutationOutcome: "unknown" }, "POST", "r").mutationOutcome, "unknown", "an explicit tag wins");
  assert.equal(httpErrorDiagnostics({ code: "conflict" }, "GET", "r").mutationOutcome, "not-applicable");
});
