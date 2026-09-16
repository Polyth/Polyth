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

test("failed-send state distinguishes authoritative retry from unknown admission", () => {
  clearSendFailure("session-recovery");
  let notifications = 0;
  const off = subscribeSendFailures(() => { notifications += 1; });
  try {
    assert.equal(isUnavailableSendError(new Error("HTTP 503 Service Unavailable")), true);
    assert.equal(isUnavailableSendError(new Error("HTTP 500 Internal Server Error")), false);
    assert.equal(reportSendFailure("session-recovery", Object.assign(new Error("HTTP 503 — unavailable"), { status: 503 }))?.kind, "unknown");
    assert.deepEqual(getSendFailure("session-recovery"), {
      sessionId: "session-recovery",
      kind: "unknown",
    });
    clearSendFailure("session-recovery");
    assert.equal(getSendFailure("session-recovery"), null);
    assert.equal(notifications, 2);
  } finally {
    off();
    clearSendFailure("session-recovery");
  }
});

test("a live direct prompt cannot be surfaced as unknown by reconciliation", async () => {
  const mutationIntent = await readFile(new URL("../src/mutationIntent.ts", import.meta.url), "utf8");
  const sendFailure = await readFile(new URL("../src/sendFailure.ts", import.meta.url), "utf8");

  assert.match(mutationIntent, /activeLocalMutationIds\.add\(intent\.operationId\)/);
  assert.match(mutationIntent, /finally\s*\{\s*activeLocalMutationIds\.delete\(intent\.operationId\)/);
  assert.match(sendFailure, /code === "outcome-unknown" && !shouldSurfaceLocalMutationRecovery\(sessionId\)/);
});

test("harness recovery registers above the composer, not inside execution", async () => {
  const recoveryEntry = await readFile(
    new URL("../../../packages/harness-runtime/widgets/index.tsx", import.meta.url),
    "utf8",
  );
  const runtimeEntry = await readFile(
    new URL("../../../packages/harness-runtime/widgets/runtime.tsx", import.meta.url),
    "utf8",
  );

  assert.match(recoveryEntry, /id:\s*"harnesses\.transition"[\s\S]*?slot:\s*"session\.composer\.before"/);
  assert.match(runtimeEntry, /id:\s*"harnesses\.transition"[\s\S]*?slot:\s*"session\.composer\.before"/);
  assert.doesNotMatch(recoveryEntry, /slot:\s*"composer\.execution"/);
  assert.doesNotMatch(runtimeEntry, /slot:\s*"composer\.execution"/);
});

test("recovery surfaces preserve drafts and never auto-send a failed turn", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  const timeline = await readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  const banner = await readFile(new URL("../src/components/RuntimeEpochBanner.tsx", import.meta.url), "utf8");

  assert.match(composer, /<Notice[\s\S]*?className="composer-send-failure"[\s\S]*?role="alert"/);
  assert.match(composer, /Checking whether this was applied/);
  // An uncertain outcome is reported without a retry action — the composer
  // never re-offers a mutation that may already have applied. It also no
  // longer disables sending: a new message is a new intent, and the server
  // queues it behind the uncertain turn instead of replaying it.
  assert.match(composer, /failedSend\.kind === "unknown"[\s\S]{0,24}\?\s*\{\}/);
  assert.doesNotMatch(composer, /sendDisabled = [\s\S]{0,200}failedSend/);
  assert.match(timeline, /applyComposerSeed\(sessionId, `turn-failed:\$\{turn\.turnId\}`/);
  assert.match(timeline, /requestComposerReplace\(draft\.text\)/);
  assert.doesNotMatch(timeline, /sendMessage\(lastUser/);
  assert.match(banner, /runtimeRecovery\.technicalDetails/);
  assert.match(banner, /uncertainRecoveryWarning/);
  assert.doesNotMatch(banner, /runtimeRecovery\.ownedBody/);
  assert.doesNotMatch(banner, /runtimeRecovery\.keepBlocked/);
  assert.doesNotMatch(banner, /authorityId|instanceToken|recoveryContext/);
});
