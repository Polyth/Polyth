import assert from "node:assert/strict";
import test from "node:test";

import { BUG_REPORT_LIMITS, base64DecodedLength, bugReportStatus, isTesterPassword, parseBugReport, type BugReportPayload } from "../src/bugReport.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
// The smallest base64 that starts like a JPEG (FF D8 FF E0).
const JPEG = "/9j/4AAQ";

function report(): BugReportPayload {
  return {
    version: 1,
    reportId: "6f1c2b9e-4d3a-4c1b-9a8e-0123456789ab",
    install: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-11-19T11:59:00.000Z",
    app: {
      version: "1.2.357-nightly", channel: "nightly", edition: "standard", platform: "darwin", arch: "arm64",
      osVersion: "24.6.0", electron: "39.2.1", chromium: "142.0.7444.59", packaged: true, locale: "uk",
    },
    web: { build: "abc123", serverVersion: "1.2.357-nightly", view: "chat", viewport: { width: 1440, height: 900, scale: 2 } },
    settings: { "ui.theme": "midnight", "ui.fontSize": 15, "desktop.closeToTray": true },
    packages: [{ id: "voice-mode", version: "0.3.0" }],
    errors: [{ time: "2026-11-19T11:58:00.000Z", text: "Polyth error report\nAction: Start a new chat" }],
    text: "The composer jumps when I paste.\nSteps: paste twice.",
    contact: "",
    screenshot: { type: "image/jpeg", width: 1600, height: 1000, data: JPEG },
  };
}

test("a complete report parses to an equal copy", () => {
  const input = report();
  const parsed = parseBugReport(structuredClone(input), NOW);
  assert.deepEqual(parsed, input);
  assert.deepEqual(parseBugReport({ ...input, screenshot: null, contact: "octo-cat", text: "" }, NOW)?.screenshot, null);
  // A report that waited offline for six days still goes.
  assert.ok(parseBugReport({ ...input, createdAt: "2026-11-13T12:00:00.000Z" }, NOW));
});

test("a browser report sent by its server parses; desktop-only and foreign fields do not", () => {
  const browser = () => ({
    ...report(),
    app: {
      client: "browser", version: "1.2.371-nightly", channel: "nightly", edition: "standard", platform: "ios",
      browser: "Safari 18", serverPlatform: "linux", serverArch: "x64", locale: "uk",
    },
  }) as Record<string, any>;
  const input = browser();
  assert.deepEqual(parseBugReport(structuredClone(input), NOW), input);
  assert.ok(parseBugReport({ ...input, app: { ...input.app, browser: "", platform: "unknown" } }, NOW), "an unknown browser still goes");
  const refuse = (mutate: (value: Record<string, any>) => void, label: string) => {
    const value = structuredClone(browser());
    mutate(value);
    assert.equal(parseBugReport(value, NOW), null, label);
  };
  refuse((v) => { v.app.electron = "39.2.1"; }, "desktop field on a browser report");
  refuse((v) => { v.app.userAgent = "Mozilla/5.0"; }, "raw user agent");
  refuse((v) => { v.app.browser = "Chrome/131.0.6778.85 (X11)"; }, "browser is name + major only");
  refuse((v) => { v.app.serverPlatform = "android"; }, "server platform");
  refuse((v) => { v.app.edition = "workstation"; }, "edition");
  refuse((v) => { v.app.channel = "stable"; }, "channel contradicts version");
  refuse((v) => { v.app.client = "phone"; }, "unknown client");
});

test("unknown fields anywhere reject the report", () => {
  const refuse = (mutate: (value: Record<string, any>) => void, label: string) => {
    const value = structuredClone(report()) as Record<string, any>;
    mutate(value);
    assert.equal(parseBugReport(value, NOW), null, label);
  };
  refuse((v) => { v.password = "x"; }, "top-level extra");
  refuse((v) => { v.app.hostname = "box"; }, "app extra");
  refuse((v) => { v.web.sessionId = "s1"; }, "web extra");
  refuse((v) => { v.web.viewport.dpi = 2; }, "viewport extra");
  refuse((v) => { v.packages[0].path = "/home/x"; }, "package extra");
  refuse((v) => { v.errors[0].stack = "at x"; }, "error extra");
  refuse((v) => { v.screenshot.name = "shot.jpg"; }, "screenshot extra");
  refuse((v) => { delete v.contact; }, "missing field");
});

test("values outside the allowlisted shapes are refused", () => {
  const refuse = (mutate: (value: Record<string, any>) => void, label: string) => {
    const value = structuredClone(report()) as Record<string, any>;
    mutate(value);
    assert.equal(parseBugReport(value, NOW), null, label);
  };
  refuse((v) => { v.version = 2; }, "schema version");
  refuse((v) => { v.reportId = "not-a-uuid"; }, "report id");
  refuse((v) => { v.install = "ABC"; }, "install id");
  refuse((v) => { v.createdAt = "2026-11-21T12:00:00.000Z"; }, "created two days ahead");
  refuse((v) => { v.createdAt = "2026-11-11T12:00:00.000Z"; }, "waited longer than a week");
  refuse((v) => { v.app.channel = "stable"; }, "channel contradicts version");
  refuse((v) => { v.app.version = "1.2.357-beta"; }, "unknown version suffix");
  refuse((v) => { v.app.platform = "android"; }, "platform");
  refuse((v) => { v.app.osVersion = "24.6\n0"; }, "control char in a line");
  refuse((v) => { v.web.view = "/sessions/abc?x=1"; }, "view as a path");
  refuse((v) => { v.web.viewport.scale = 0; }, "scale");
  refuse((v) => { v.settings["Ui theme"] = "x"; }, "setting key shape");
  refuse((v) => { v.settings["ui.prompt"] = "x".repeat(BUG_REPORT_LIMITS.settingValueChars + 1); }, "long setting");
  refuse((v) => { v.settings["ui.nested"] = { a: 1 }; }, "object setting");
  refuse((v) => { v.settings["ui.nan"] = Number.NaN; }, "non-finite setting");
  refuse((v) => { v.packages = Array.from({ length: BUG_REPORT_LIMITS.packages + 1 }, () => ({ id: "a", version: "1" })); }, "too many packages");
  refuse((v) => { v.errors[0].time = "2026-10-01T00:00:00.000Z"; }, "error older than a week");
  refuse((v) => { v.text = "x".repeat(BUG_REPORT_LIMITS.textChars + 1); }, "long text");
  refuse((v) => { v.text = "bell\u0007"; }, "control char in text");
  refuse((v) => { v.contact = "me@example.com"; }, "contact is not a username");
  refuse((v) => { v.screenshot.type = "image/png"; }, "png");
  refuse((v) => { v.screenshot.data = "iVBORw0KGgo="; }, "not a jpeg");
  refuse((v) => { v.screenshot.width = BUG_REPORT_LIMITS.screenshotEdge + 1; }, "too wide");
  refuse((v) => { v.screenshot.data = "/9j/4AA"; }, "base64 length");
});

test("a screenshot over the byte limit is refused without decoding it", () => {
  const over = `/9j/${"A".repeat(Math.ceil((BUG_REPORT_LIMITS.screenshotBytes * 4) / 3))}`;
  const padded = over + "A".repeat((4 - (over.length % 4)) % 4);
  assert.ok(base64DecodedLength(padded) > BUG_REPORT_LIMITS.screenshotBytes);
  const value = report();
  value.screenshot = { ...value.screenshot!, data: padded };
  assert.equal(parseBugReport(value, NOW), null);
  assert.equal(base64DecodedLength("/9j/4AAQ"), 6);
  assert.equal(base64DecodedLength("/9j/4A=="), 4);
});

test("result statuses", () => {
  assert.equal(bugReportStatus("created"), 200);
  assert.equal(bugReportStatus("added"), 200);
  assert.equal(bugReportStatus("password"), 401);
  assert.equal(bugReportStatus("version"), 422);
  assert.equal(bugReportStatus("rate"), 429);
  assert.equal(bugReportStatus("unavailable"), 503);
});

test("a tester password is printable ASCII without spaces", () => {
  assert.equal(isTesterPassword("hunter2!#"), true);
  assert.equal(isTesterPassword("two words"), false);
  assert.equal(isTesterPassword("пароль"), false);
  assert.equal(isTesterPassword(""), false);
  assert.equal(isTesterPassword("x".repeat(BUG_REPORT_LIMITS.passwordChars + 1)), false);
  assert.equal(isTesterPassword(42), false);
});
