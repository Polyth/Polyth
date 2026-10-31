import test from "node:test";
import assert from "node:assert/strict";
import { activateSession, claimUiErrorLifetime, clearUiError, getState, setUiError } from "../src/store.ts";

test("transient errors replace stale actions and dismiss after seven seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clearUiError();

  setUiError("First failure", { label: "Retry", run: () => undefined });
  assert.equal(getState().uiError, "First failure");
  assert.equal(getState().uiErrorAction?.label, "Retry");

  setUiError("Latest failure");
  assert.equal(getState().uiError, "Latest failure");
  assert.equal(getState().uiErrorAction, null);
  t.mock.timers.tick(6_999);
  assert.equal(getState().uiError, "Latest failure");
  t.mock.timers.tick(1);
  assert.equal(getState().uiError, null);
});

test("keyed turn errors do not replay after a session remount", () => {
  const firstKey = "session-a:turn-1:failed";
  const secondKey = "session-b:turn-2:failed";
  clearUiError();

  setUiError("Session A failed", null, firstKey);
  clearUiError();
  setUiError("Session B failed", null, secondKey);
  assert.equal(getState().uiError, "Session B failed");
  clearUiError();

  // Returning to either session must leave the banner dismissed; the durable
  // server notification remains available in Notification Centre.
  setUiError("Session A failed", null, firstKey);
  assert.equal(getState().uiError, null);
  setUiError("Session B failed", null, secondKey);
  assert.equal(getState().uiError, null);
});

test("switching sessions dismisses transient error banner", (t) => {
  t.after(() => activateSession(null));
  clearUiError();
  activateSession("session-test-a");

  setUiError("Error in session A", { label: "Retry", run: () => undefined });
  assert.equal(getState().uiError, "Error in session A");
  assert.ok(getState().uiErrorAction);

  activateSession("session-test-b");
  assert.equal(getState().uiError, null);
  assert.equal(getState().uiErrorAction, null);
});

test("with a presenter mounted the store never times out the error; every raise is a new occurrence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  clearUiError();
  const release = claimUiErrorLifetime();
  try {
    const before = getState().uiErrorSeq;
    setUiError("Send: failed");
    setUiError("Send: failed");
    assert.equal(getState().uiErrorSeq, before + 2, "the same text raised again still counts");
    t.mock.timers.tick(60_000);
    assert.equal(getState().uiError, "Send: failed", "the presenter's pausable countdown owns the lifetime");
    setUiError("Nothing to compact", null, undefined, "info");
    assert.equal(getState().uiErrorKind, "info");
    clearUiError();
    assert.equal(getState().uiErrorKind, "error");
  } finally {
    release();
    clearUiError();
  }
  setUiError("Without a presenter");
  t.mock.timers.tick(7_000);
  assert.equal(getState().uiError, null, "an error nobody presents still expires");
});
