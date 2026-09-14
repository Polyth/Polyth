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
