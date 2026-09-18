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
  const responseFooter = await readFile(new URL("../src/components/ChatResponseFooter.tsx", import.meta.url), "utf8");
  const banner = await readFile(new URL("../src/components/RuntimeEpochBanner.tsx", import.meta.url), "utf8");

  assert.match(composer, /<Notice[\s\S]*?className="composer-send-failure"[\s\S]*?role="alert"/);
  assert.match(composer, /failedSend\?\.kind === "unavailable"/);
  assert.doesNotMatch(composer, /failedSend(?:\?\.)?kind === "unknown"/);
  assert.match(composer, /const retryFailedSend = useCallback\([\s\S]*?alreadyVisible[\s\S]*?send\(undefined, undefined, alreadyVisible\)/);
  assert.match(composer, /delivery !== "queue" && !hiddenUserMessage/);
  assert.match(composer, /hiddenUserMessage \? \{ hiddenUserMessage: true \} : \{\}/);
  // An uncertain outcome is not surfaced as a retryable composer notice: the
  // mutation may already have applied, so offering replay would risk a duplicate.
  assert.doesNotMatch(composer, /sendDisabled = [\s\S]{0,200}failedSend/);
  assert.doesNotMatch(timeline, /applyComposerSeed\(sessionId, `turn-failed:\$\{turn\.turnId\}`/);
  assert.match(timeline, /sendMessage\(lastUser\.raw \?\? lastUser\.text[\s\S]{0,300}hiddenUserMessage: true/);
  assert.match(timeline, /eventSeq: lastUserMessage\.eventSeq/);
  assert.match(responseFooter, /api\.rewind\(session\.id, regeneratePrompt\.eventSeq\)[\s\S]{0,400}\.then\(\(marker\) => \{[\s\S]{0,300}applyEvent\(marker\);[\s\S]{0,300}return sendMessage\(regeneratePrompt\.text/);
  assert.doesNotMatch(responseFooter, /sendMessage\(regeneratePrompt\.text[\s\S]{0,300}hiddenUserMessage: true/);
  assert.doesNotMatch(responseFooter, /requestComposerReplace\(regeneratePrompt/);
  assert.match(banner, /runtimeRecovery\.technicalDetails/);
  assert.match(banner, /uncertainRecoveryWarning/);
  assert.doesNotMatch(banner, /runtimeRecovery\.ownedBody/);
  assert.doesNotMatch(banner, /runtimeRecovery\.keepBlocked/);
  assert.doesNotMatch(banner, /authorityId|instanceToken|recoveryContext/);
});
