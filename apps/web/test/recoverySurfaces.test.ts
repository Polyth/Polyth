import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  RECONNECT_PILL_DELAY_MS,
  createReconnectPillState,
} from "../src/reconnectPillState.ts";
import {
  clearSendFailure,
  getSendFailure,
  isUnavailableSendError,
  reportSendFailure,
  subscribeSendFailures,
} from "../src/sendFailure.ts";

test("reconnect pill waits across unhealthy transitions and clears immediately", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes: boolean[] = [];
  const state = createReconnectPillState((visible) => changes.push(visible));

  state.update("disconnected");
  t.mock.timers.tick(RECONNECT_PILL_DELAY_MS - 1);
  assert.equal(state.visible(), false);

  state.update("connecting");
  t.mock.timers.tick(1);
  assert.equal(state.visible(), true);
  assert.deepEqual(changes, [true]);

  state.update("connected");
  assert.equal(state.visible(), false);
  assert.deepEqual(changes, [true, false]);

  state.update("connecting");
  state.update("connected");
  t.mock.timers.tick(RECONNECT_PILL_DELAY_MS);
  assert.equal(state.visible(), false, "a recovered connection cancels the pending reveal");
  state.dispose();
});

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
  const reconnect = await readFile(new URL("../src/components/ReconnectPill.tsx", import.meta.url), "utf8");

  assert.match(reconnect, /registerSlot\("app\.header\.actions", "shell\.reconnect-status"/);
  assert.match(reconnect, /onClick=\{reconnectSync\}/);
  assert.match(composer, /className="composer-send-failure" role="alert"/);
  assert.match(composer, /saveDraft\(targetSessionId, t\)/);
  assert.match(timeline, /applyComposerSeed\(sessionId, `turn-failed:\$\{turn\.turnId\}`/);
  assert.match(timeline, /requestComposerReplace\(draft\.text\)/);
  assert.doesNotMatch(timeline, /sendMessage\(lastUser/);
});
