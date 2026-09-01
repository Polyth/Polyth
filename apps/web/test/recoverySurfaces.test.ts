import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clearSendFailure,
  getSendFailure,
  isUnavailableSendError,
  reportSendFailure,
  subscribeSendFailures,
} from "../src/sendFailure.ts";

test("failed-send state records only unavailable admission failures", () => {
  clearSendFailure("session-recovery");
  let notifications = 0;
  const off = subscribeSendFailures(() => { notifications += 1; });
  try {
    assert.equal(isUnavailableSendError(new Error("HTTP 503 Service Unavailable")), true);
    assert.equal(isUnavailableSendError(new Error("HTTP 500 Internal Server Error")), false);
    assert.equal(reportSendFailure("session-recovery", new Error("HTTP 503 — unavailable"))?.kind, "unavailable");
    assert.deepEqual(getSendFailure("session-recovery"), {
      sessionId: "session-recovery",
      kind: "unavailable",
    });
    clearSendFailure("session-recovery");
    assert.equal(getSendFailure("session-recovery"), null);
    assert.equal(notifications, 2);
  } finally {
    off();
    clearSendFailure("session-recovery");
  }
});

test("recovery surfaces preserve drafts and never auto-send a failed turn", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  const timeline = await readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  const banner = await readFile(new URL("../src/components/RuntimeEpochBanner.tsx", import.meta.url), "utf8");

  assert.match(composer, /<Notice[\s\S]*?className="composer-send-failure"[\s\S]*?role="alert"/);
  assert.match(composer, /saveDraft\(targetSessionId, t\)/);
  assert.match(timeline, /applyComposerSeed\(sessionId, `turn-failed:\$\{turn\.turnId\}`/);
  assert.match(timeline, /requestComposerReplace\(draft\.text\)/);
  assert.doesNotMatch(timeline, /sendMessage\(lastUser/);
  assert.match(banner, /runtimeRecovery\.technicalDetails/);
  assert.match(banner, /uncertainRecoveryWarning/);
  assert.doesNotMatch(banner, /runtimeRecovery\.keepBlocked/);
  assert.doesNotMatch(banner, /authorityId|instanceToken|recoveryContext/);
});
