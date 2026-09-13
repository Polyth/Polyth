import test from "node:test";
import assert from "node:assert/strict";
import { TRANSIENT_TURN_NOTICE_MS, transientTurnNoticeKey } from "../src/turnNotice.ts";

test("ordinary failed and aborted turn notices are keyed to their session and turn", () => {
  assert.equal(TRANSIENT_TURN_NOTICE_MS, 10_000);
  assert.equal(
    transientTurnNoticeKey("session-a", { turnId: "turn-1", status: "failed" }),
    "session-a:turn-1:failed",
  );
  assert.equal(
    transientTurnNoticeKey("session-a", { turnId: "turn-2", status: "aborted" }),
    "session-a:turn-2:aborted",
  );
  assert.equal(
    transientTurnNoticeKey("session-a", { turnId: "turn-3", status: "stopped" }),
    null,
  );
  assert.equal(transientTurnNoticeKey(null, { turnId: "turn-4", status: "failed" }), null);
});
