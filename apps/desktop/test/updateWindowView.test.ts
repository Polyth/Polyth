import assert from "node:assert/strict";
import test from "node:test";
import {
  formatBytes,
  parsePendingUpdate,
  pendingUpdateOutcome,
  UPDATE_WINDOW_SIZE,
  updateWindowBounds,
  updateWindowView,
} from "../src/updateWindowView.ts";

const actions = (view: ReturnType<typeof updateWindowView>) => view.buttons.map((button) => `${button.action}${button.primary ? "*" : ""}`);

test("a download shows its bytes, speed and percentage and can be hidden", () => {
  const view = updateWindowView({
    phase: "downloading", message: "", version: "1.2.0",
    percent: 42.7, transferred: 41.2 * 1024 * 1024, total: 98 * 1024 * 1024, bytesPerSecond: 4.1 * 1024 * 1024,
  });
  assert.equal(view.title, "Downloading Polyth 1.2.0");
  assert.equal(view.detail, "41.2 MB of 98.0 MB · 4.1 MB/s");
  assert.ok(Math.abs((view.progress ?? 0) - 0.427) < 1e-9);
  assert.equal(view.progressLabel, "42%");
  assert.deepEqual(actions(view), ["hide"]);
  assert.equal(view.closable, true);
});

test("a download before its first progress report runs the bar indeterminate", () => {
  const view = updateWindowView({ phase: "downloading", message: "", version: "1.2.0" });
  assert.equal(view.progress, null);
  assert.equal(view.progressLabel, undefined);
  assert.equal(view.detail, "Starting the download…");
});

test("a finished download asks to restart, then the handover cannot be dismissed", () => {
  assert.deepEqual(actions(updateWindowView({ phase: "downloaded", message: "", version: "1.2.0" })), ["hide", "install*"]);
  const installing = updateWindowView({ phase: "installing", message: "", version: "1.2.0" });
  assert.equal(installing.title, "Installing Polyth 1.2.0…");
  assert.equal(installing.progress, null);
  assert.deepEqual(installing.buttons, []);
  assert.equal(installing.closable, false);
});

test("found, installed and failed updates offer their own next step", () => {
  assert.deepEqual(actions(updateWindowView({ phase: "available", message: "", version: "1.2.0" })), ["hide", "download*"]);
  assert.deepEqual(actions(updateWindowView({ phase: "installed", message: "", version: "1.2.0" })), ["hide*"]);
  const failed = updateWindowView({ phase: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
  assert.equal(failed.detail, "net::ERR_INTERNET_DISCONNECTED");
  assert.deepEqual(actions(failed), ["hide", "retry*"]);
});

test("byte sizes read like a download dialog", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(150 * 1024 * 1024), "150 MB");
  assert.equal(formatBytes(2.25 * 1024 ** 3), "2.3 GB");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("the window sits in the bottom-right corner of the work area", () => {
  assert.deepEqual(
    updateWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 }),
    { x: 1920 - UPDATE_WINDOW_SIZE.width - 16, y: 1040 - UPDATE_WINDOW_SIZE.height - 16, ...UPDATE_WINDOW_SIZE },
  );
  // A second display to the left, and one too small for the window.
  assert.deepEqual(updateWindowBounds({ x: -1280, y: 0, width: 1280, height: 984 }).x, -1280 + 1280 - UPDATE_WINDOW_SIZE.width - 16);
  assert.deepEqual(updateWindowBounds({ x: 0, y: 0, width: 300, height: 120 }), { x: 0, y: 0, width: 300, height: 120 });
});

test("the next start reports whether the handed-over install happened", () => {
  const pending = parsePendingUpdate('{"version":"1.2.0","from":"1.1.9"}\n');
  assert.deepEqual(pending, { version: "1.2.0", from: "1.1.9" });
  assert.equal(pendingUpdateOutcome(pending, "1.2.0")?.phase, "installed");
  const failed = pendingUpdateOutcome(pending, "1.1.9");
  assert.equal(failed?.phase, "error");
  assert.match(failed?.message ?? "", /1\.2\.0 did not install/);
  assert.equal(pendingUpdateOutcome(pending, "1.3.0"), null);
  assert.equal(parsePendingUpdate("not json"), null);
  assert.equal(parsePendingUpdate('{"version":""}'), null);
});
