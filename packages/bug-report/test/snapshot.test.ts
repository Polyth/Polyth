import assert from "node:assert/strict";
import test from "node:test";

import { parseBugReport } from "@polyth/contracts/bug-report";

import { contactName, enabledPackages, recentErrors, uiSettings, viewName, viewport, webFacts, withoutHomePaths } from "../src/snapshot.ts";
import { reportBridge } from "../widgets/bridge.ts";
import { en } from "../src/i18n/en.ts";
import { bugReportLocales } from "../src/i18n/index.ts";

const page = { rootFlags: { appearance: "dark", reduceAnimations: "true", sessionReveal: "abc123", locale: "uk" }, prefersReducedMotion: false, prefersDark: true, language: "uk-UA" };

test("only allowlisted interface settings leave, and free text never does", () => {
  const settings = uiSettings({
    theme: "midnight", density: "compact", fontSize: 15, sendOnEnter: true, defaultModel: "anthropic/opus",
    productName: "Ann's private studio", branchTemplate: "ann/{slug}", conflictAgentPrompt: "secret prompt",
    accentColor: "#ff00aa", showArchived: false, compactionDefault: { mode: "auto" }, chatFontSize: Number.NaN,
  }, page);
  assert.deepEqual(settings, {
    "ui.theme": "midnight",
    "ui.accentColor": "#ff00aa",
    "ui.density": "compact",
    "ui.fontSize": 15,
    "ui.sendOnEnter": true,
    "ui.showArchived": false,
    "ui.defaultModel": "anthropic/opus",
    "ui.root.appearance": "dark",
    "ui.root.reduceAnimations": "true",
    "ui.root.locale": "uk",
    "ui.prefersReducedMotion": false,
    "ui.prefersDark": true,
    "ui.language": "uk-UA",
  });
  assert.ok(!JSON.stringify(settings).includes("Ann"));
});

test("the view names a view or page, never a session or a path", () => {
  assert.equal(viewName({ activeView: "chat", overlay: null }), "chat");
  assert.equal(viewName({ activeView: "chat", overlay: "settings" }), "overlay:settings");
  assert.equal(viewName({ activeView: "chat", overlay: null, activePage: { pageId: "agents" } }), "page:agents");
  assert.equal(viewName({ activeView: "/projects/x y?z", overlay: null }), "projectsxyz");
});

test("viewport and web facts stay inside the wire's ranges", () => {
  assert.deepEqual(viewport(1440.4, 899.6, 2), { width: 1440, height: 900, scale: 2 });
  assert.deepEqual(viewport(Number.NaN, -5, 0.1), { width: 0, height: 0, scale: 0.25 });
  assert.deepEqual(webFacts({ build: "abc 123", serverVersion: "dev", view: "chat", viewport: viewport(1, 1, 1) }).build, "");
  assert.equal(webFacts({ build: "abc123", serverVersion: "1.2.357-nightly", view: "chat", viewport: viewport(1, 1, 1) }).serverVersion, "1.2.357-nightly");
});

test("recent errors keep their report, lose home folders and stray control characters", () => {
  const errors = recentErrors([
    { time: "bad", text: "dropped" },
    { time: "2026-11-19T11:00:00.000Z", text: "Polyth error report\nError: ENOENT /Users/ann/projects/x\u0007" },
    { time: "2026-11-19T11:01:00.000Z", text: "C:\\Users\\ann\\AppData failed" },
    { time: "2026-11-19T11:02:00.000Z", text: "   " },
  ]);
  assert.deepEqual(errors, [
    { time: "2026-11-19T11:00:00.000Z", text: "Polyth error report\nError: ENOENT ~/projects/x" },
    { time: "2026-11-19T11:01:00.000Z", text: "~\\AppData failed" },
  ]);
  assert.equal(recentErrors(Array.from({ length: 14 }, (_, index) => ({ time: "2026-11-19T11:00:00.000Z", text: `e${index}` }))).at(0)?.text, "e4");
  assert.equal(withoutHomePaths("/home/ann/.config and /home/bob"), "~/.config and ~");
});

test("enabled packages come from the package list, bounded and sorted", () => {
  assert.deepEqual(enabledPackages({ packages: [
    { id: "voice-mode", enabled: true, status: "ready" },
    { id: "agents", enabled: true },
    { id: "glance", enabled: false },
    { id: "recap", enabled: true, status: "disabled" },
    { id: "../escape", enabled: true },
  ] }), [{ id: "agents", version: "bundled" }, { id: "voice-mode", version: "bundled" }]);
  assert.deepEqual(enabledPackages(null), []);
});

test("a contact is a GitHub username or nothing", () => {
  assert.equal(contactName(" @octo-cat "), "octo-cat");
  assert.equal(contactName("ann@example.com"), "");
  assert.equal(contactName(""), "");
});

test("the page's part of a report passes the shared wire validation", () => {
  const now = Date.parse("2026-11-19T12:00:00.000Z");
  const report = {
    version: 1,
    reportId: "6f1c2b9e-4d3a-4c1b-9a8e-0123456789ab",
    install: "0123456789abcdef0123456789abcdef",
    createdAt: "2026-11-19T12:00:00.000Z",
    app: { version: "1.2.357-nightly", channel: "nightly", edition: "standard", platform: "linux", arch: "x64", osVersion: "6.8.0", electron: "39.2.1", chromium: "142.0.1", packaged: true, locale: "en-US" },
    web: webFacts({ build: "abc123", serverVersion: "1.2.357-nightly", view: viewName({ activeView: "chat", overlay: null }), viewport: viewport(1280, 800, 1) }),
    settings: uiSettings({ theme: "midnight" }, page),
    packages: enabledPackages({ packages: [{ id: "agents", enabled: true }] }),
    errors: recentErrors([{ time: "2026-11-19T11:00:00.000Z", text: "Polyth error report\nCode: E1" }]),
    text: "",
    contact: contactName("octocat"),
    screenshot: null,
  };
  assert.ok(parseBugReport(report, now));
});

test("the desktop bridge is recognised only when complete", () => {
  const fn = async () => ({});
  assert.equal(reportBridge(undefined), null);
  assert.equal(reportBridge({ polythDesktop: {} }), null);
  assert.equal(reportBridge({ polythDesktop: { bugReport: { state: fn, capture: fn } } }), null);
  assert.ok(reportBridge({ polythDesktop: { bugReport: { state: fn, capture: fn, send: fn } } }));
});

test("every locale has exactly the English keys and keeps placeholders", () => {
  const keys = Object.keys(en).sort();
  for (const [locale, messages] of Object.entries(bugReportLocales)) {
    assert.deepEqual(Object.keys(messages).sort(), keys, locale);
    for (const key of keys) {
      const wanted = (en[key as keyof typeof en].match(/\{\w+\}/g) ?? []).sort();
      const got = (messages[key as keyof typeof en].match(/\{\w+\}/g) ?? []).sort();
      assert.deepEqual(got, wanted, `${locale} ${key}`);
    }
  }
});
