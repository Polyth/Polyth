import test from "node:test";
import assert from "node:assert/strict";
import { clearUiError, getState, setUiError } from "../src/store.ts";

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
