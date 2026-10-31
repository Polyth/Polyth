import test from "node:test";
import assert from "node:assert/strict";
import { transientTurnNoticeKey } from "../src/turnNotice.ts";

test("only failed turns get a transient notice key", () => {
  assert.equal(
    transientTurnNoticeKey("session-a", { turnId: "turn-1", status: "failed" }),
    "session-a:turn-1:failed",
  );
  assert.equal(
    transientTurnNoticeKey("session-a", { turnId: "turn-2", status: "aborted" }),
    null,
  );
  assert.equal(
    transientTurnNoticeKey("session-a", { turnId: "turn-3", status: "stopped" }),
    null,
  );
  assert.equal(transientTurnNoticeKey(null, { turnId: "turn-4", status: "failed" }), null);
});

test("a provider-limit stop never falls back to the generic failure notice", () => {
  const limit = { scope: "rate" as const, resumeAt: 5_000, attempt: 1 };
  assert.equal(transientTurnNoticeKey("session-a", { turnId: "turn-1", status: "failed", limit, providerLimited: true }), null);
  // The wait ended (model/harness switch, Cancel wait): limit is gone, the turn stays limited.
  assert.equal(transientTurnNoticeKey("session-a", { turnId: "turn-1", status: "failed", providerLimited: true }), null);
});

test("a failure on a harness the session switched away from has no notice", () => {
  const turn = { turnId: "turn-1", status: "failed" as const, harnessId: "claude" };
  assert.equal(transientTurnNoticeKey("session-a", turn, "claude"), "session-a:turn-1:failed");
  assert.equal(transientTurnNoticeKey("session-a", turn, "claude-personal"), null);
  assert.equal(transientTurnNoticeKey("session-a", turn, null), "session-a:turn-1:failed");
});
