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
