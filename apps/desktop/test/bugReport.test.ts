import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseBugReport } from "@polyth/contracts/bug-report";

import {
  bugReportOrigin,
  createBugReportClient,
  dailyInstallId,
  encodeScreenshot,
  type BugReportClientOptions,
  type CapturedImage,
} from "../src/bugReport.ts";

const NIGHTLY = "1.2.357-nightly";
// A JPEG-looking buffer (FF D8 FF E0 …).
const jpegOf = (bytes: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, bytes - 4), 1)]);

test("only nightly standard builds report, to an https or loopback relay", () => {
  const env = {};
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "standard", env }), "https://reports.polyth.app");
  assert.equal(bugReportOrigin({ version: "1.2.357", edition: "standard", env }), null);
  assert.equal(bugReportOrigin({ version: "1.2.357", edition: "standard", env: { POLYTH_BUG_REPORT: "1" } }), "https://reports.polyth.app");
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "workstation", env }), null);
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "standard", env: { POLYTH_BUG_REPORT_ORIGIN: "off" } }), null);
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "standard", env: { POLYTH_BUG_REPORT_ORIGIN: "http://reports.example" } }), null);
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "standard", env: { POLYTH_BUG_REPORT_ORIGIN: "https://u:p@reports.example" } }), null);
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "standard", env: { POLYTH_BUG_REPORT_ORIGIN: "http://127.0.0.1:8788/" } }), "http://127.0.0.1:8788");
  assert.equal(bugReportOrigin({ version: NIGHTLY, edition: "standard", env: { POLYTH_BUG_REPORT_ORIGIN: "https://reports.example/x" } }), "https://reports.example");
});

test("the install id is stable within a UTC day and unrelated across days", () => {
  const secret = "ab".repeat(32);
  const morning = Date.parse("2026-11-19T01:00:00Z");
  const evening = Date.parse("2026-11-19T23:00:00Z");
  const next = Date.parse("2026-11-20T00:00:01Z");
  assert.match(dailyInstallId(secret, morning), /^[0-9a-f]{32}$/);
  assert.equal(dailyInstallId(secret, morning), dailyInstallId(secret, evening));
  assert.notEqual(dailyInstallId(secret, morning), dailyInstallId(secret, next));
  assert.notEqual(dailyInstallId("cd".repeat(32), morning), dailyInstallId(secret, morning));
});

class FakeImage implements CapturedImage {
  resized: Array<{ width: number; height: number }> = [];
  private readonly size: { width: number; height: number };
  private readonly bytes: (width: number, quality: number) => number;
  constructor(size: { width: number; height: number }, bytes: (width: number, quality: number) => number) {
    this.size = size;
    this.bytes = bytes;
  }
  getSize() { return this.size; }
  resize(options: { width: number; height: number }): CapturedImage {
    this.resized.push({ width: options.width, height: options.height });
    return new FakeImage({ width: options.width, height: options.height }, this.bytes);
  }
  toJPEG(quality: number) { return jpegOf(this.bytes(this.size.width, quality)); }
}

test("screenshots shrink to the wire's edge and re-encode until they fit", () => {
  const retina = new FakeImage({ width: 3200, height: 2000 }, () => 400_000);
  const shot = encodeScreenshot(retina);
  assert.deepEqual(retina.resized, [{ width: 1600, height: 1000 }]);
  assert.equal(shot?.width, 1600);
  assert.equal(shot?.height, 1000);

  const small = new FakeImage({ width: 800, height: 600 }, () => 10_000);
  assert.equal(encodeScreenshot(small)?.width, 800);
  assert.equal(small.resized.length, 0, "a small window is not resized");

  // Too big at full size even at the lowest quality: the edge shrinks.
  const heavy = new FakeImage({ width: 1600, height: 1000 }, (width, quality) => (width >= 1600 ? 2_000_000 : quality <= 60 ? 900_000 : 1_600_000));
  const fitted = encodeScreenshot(heavy);
  assert.equal(fitted?.width, 1200);
  assert.ok(fitted && fitted.jpeg.length <= 1_500_000);

  assert.equal(encodeScreenshot(new FakeImage({ width: 1600, height: 1000 }, () => 5_000_000)), null);
  assert.equal(encodeScreenshot(new FakeImage({ width: 0, height: 0 }, () => 10)), null);
});

interface Call { url: string; authorization: string; body: unknown }

function harness(t: test.TestContext, overrides: Partial<BugReportClientOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-bug-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: Call[] = [];
  const answers: Array<() => Response | Promise<Response>> = [];
  let clock = Date.parse("2026-11-19T12:00:00.000Z");
  const options: BugReportClientOptions = {
    dir,
    origin: "https://reports.example",
    app: {
      version: NIGHTLY, edition: "standard", platform: "darwin", arch: "arm64", osVersion: "24.6.0",
      electron: "39.2.1", chromium: "142.0.7444.59", packaged: true,
    },
    locale: () => "uk",
    desktopSettings: () => ({ "desktop.updateChannel": "nightly", "desktop.closeToTray": true }),
    encrypt: (plain) => `sealed:${Buffer.from(plain).toString("base64")}`,
    decrypt: (stored) => stored.startsWith("sealed:") ? Buffer.from(stored.slice(7), "base64").toString() : null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") ?? "", body: JSON.parse(String(init?.body)) });
      const next = answers.shift();
      if (!next) throw new TypeError("fetch failed");
      return next();
    }) as typeof fetch,
    now: () => clock,
    log: () => {},
    ...overrides,
  };
  const make = () => createBugReportClient(options);
  const client = make();
  t.after(() => client.dispose());
  return {
    dir, calls, answers, client, make,
    advance: (ms: number) => { clock += ms; },
    reply: (status: number, body: unknown) => answers.push(() => Response.json(body, { status })),
  };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  captureId: null,
  text: "  The composer jumps when I paste.  ",
  contact: "@octo-cat",
  web: { build: "abc123", serverVersion: NIGHTLY, view: "chat", viewport: { width: 1440, height: 900, scale: 2 } },
  settings: { "ui.theme": "midnight", "desktop.updateChannel": "stable", "secret.token": "x" },
  packages: [{ id: "voice-mode", version: "0.3.0" }],
  errors: [],
  ...overrides,
});

test("the first report asks for the password, then the relay's yes keeps it sealed", async (t) => {
  const h = harness(t);
  assert.deepEqual(h.client.state(), { available: true, needsPassword: true, queued: 0 });
  assert.deepEqual(await h.client.send(draft()), { result: "password" });
  assert.equal(h.calls.length, 0, "nothing goes without a password");

  h.reply(200, { result: "created", issue: 7 });
  assert.deepEqual(await h.client.send(draft({ password: " hunter2 " })), { result: "created", issue: 7 });
  const [call] = h.calls;
  assert.equal(call!.url, "https://reports.example/v1/report");
  assert.equal(call!.authorization, "Bearer hunter2");
  const sent = parseBugReport(call!.body, Date.parse("2026-11-19T12:00:00.000Z"));
  assert.ok(sent, "the body is exactly the wire shape");
  assert.equal(sent.text, "The composer jumps when I paste.");
  assert.equal(sent.contact, "octo-cat");
  assert.equal(sent.app.channel, "nightly");
  assert.equal(sent.screenshot, null);
  // Renderer settings are ui.* only; desktop.* comes from the desktop.
  assert.deepEqual(sent.settings, { "ui.theme": "midnight", "desktop.updateChannel": "nightly", "desktop.closeToTray": true });
  assert.ok(!JSON.stringify(call!.body).includes("hunter2"), "the password is never in the body");

  const stored = readFileSync(join(h.dir, "bug-report.json"), "utf8");
  assert.ok(!stored.includes("hunter2"), "only the sealed password is written");
  assert.match(stored, /sealed:/);

  // A new run decrypts it: no prompt.
  const again = h.make();
  t.after(() => again.dispose());
  assert.equal(again.state().needsPassword, false);
  h.advance(2 * 60_000);
  h.reply(200, { result: "added", issue: 7 });
  assert.deepEqual(await again.send(draft()), { result: "added", issue: 7 });
  assert.equal(h.calls[1]!.authorization, "Bearer hunter2");
});

test("a password the relay refuses is forgotten; a typed wrong one is never kept", async (t) => {
  const h = harness(t);
  h.reply(401, { result: "password" });
  assert.deepEqual(await h.client.send(draft({ password: "wrong" })), { result: "password" });
  assert.equal(h.client.state().needsPassword, true);
  assert.ok(!readdirSync(h.dir).includes("bug-report.json") || !readFileSync(join(h.dir, "bug-report.json"), "utf8").includes("sealed:"));

  h.reply(200, { result: "created", issue: 1 });
  await h.client.send(draft({ password: "right" }));
  assert.equal(h.client.state().needsPassword, false);
  h.advance(2 * 60_000);
  h.reply(401, { result: "password" });
  assert.deepEqual(await h.client.send(draft()), { result: "password" });
  assert.equal(h.client.state().needsPassword, true, "a rotated password asks again");
  assert.ok(!readFileSync(join(h.dir, "bug-report.json"), "utf8").includes("sealed:"));
});

test("without OS encryption the password lasts only this run", async (t) => {
  const h = harness(t, { encrypt: () => null });
  assert.equal(h.client.capture(null).passwordStorage, "session", "the sheet can say so");
  h.reply(200, { result: "created", issue: 2 });
  await h.client.send(draft({ password: "hunter2" }));
  assert.equal(h.client.state().needsPassword, false);
  assert.ok(!readFileSync(join(h.dir, "bug-report.json"), "utf8").includes("hunter2"));
  const next = h.make();
  t.after(() => next.dispose());
  assert.equal(next.state().needsPassword, true);
});

test("this computer does not cap how many reports it sends", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 15; index += 1) {
    h.reply(200, { result: "created", issue: index + 1 });
    assert.equal((await h.client.send(draft({ password: "p" }))).result, "created", `report ${index}, same minute`);
  }
  assert.equal(h.calls.length, 15);
  assert.ok(!readFileSync(join(h.dir, "bug-report.json"), "utf8").includes("sent"), "no send log is kept");
});

test("an unreachable or busy relay keeps the report and sends it later", async (t) => {
  const h = harness(t);
  // fetch throws: no answer queued.
  assert.deepEqual(await h.client.send(draft({ password: "p" })), { result: "queued" });
  assert.equal(h.client.state().queued, 1);
  assert.equal(h.client.state().needsPassword, false, "the queued report needs the password later");
  const [file] = readdirSync(join(h.dir, "bug-reports"));
  assert.match(file!, /^[0-9a-f-]{36}\.json$/);
  assert.ok(!readFileSync(join(h.dir, "bug-reports", file!), "utf8").includes("\"p\""));

  h.advance(61_000);
  h.reply(429, { result: "rate" });
  assert.deepEqual(await h.client.send(draft()), { result: "queued" });
  assert.equal(h.client.state().queued, 2);

  h.reply(200, { result: "created", issue: 3 });
  h.reply(200, { result: "added", issue: 3 });
  await h.client.flushOutbox();
  assert.equal(h.client.state().queued, 0);
  const ids = h.calls.slice(-2).map((call) => (call.body as { reportId: string }).reportId);
  assert.equal(new Set(ids).size, 2, "each queued report keeps its own id");
});

test("the outbox drops reports the relay will never take, and stops on a password refusal", async (t) => {
  const h = harness(t);
  await h.client.send(draft({ password: "p" }));
  h.advance(61_000);
  await h.client.send(draft());
  assert.equal(h.client.state().queued, 2);
  h.reply(422, { result: "version" });
  h.reply(401, { result: "password" });
  await h.client.flushOutbox();
  assert.equal(h.client.state().queued, 1, "the refused version is dropped, the other waits");
  assert.equal(h.client.state().needsPassword, true);

  // Older than the relay accepts: dropped on read without a request.
  h.advance(8 * 24 * 60 * 60_000);
  const before = h.calls.length;
  await h.client.flushOutbox();
  assert.equal(h.client.state().queued, 0);
  assert.equal(h.calls.length, before);
});

test("the screenshot goes only with the capture it was shown for", async (t) => {
  const h = harness(t);
  const shot = { jpeg: jpegOf(64), width: 1600, height: 1000 };
  const capture = h.client.capture(shot);
  assert.match(capture.screenshot!.dataUrl, /^data:image\/jpeg;base64,\/9j\//);
  assert.equal(capture.base.app.channel, "nightly");
  assert.equal(capture.base.app.locale, "uk");
  assert.match(capture.base.install, /^[0-9a-f]{32}$/);
  assert.equal(capture.passwordStorage, "keychain");
  assert.deepEqual(capture.base.settings, { "desktop.updateChannel": "nightly", "desktop.closeToTray": true });

  assert.deepEqual(await h.client.send(draft({ password: "p", captureId: "another" })), { result: "invalid" });
  h.reply(200, { result: "created", issue: 4 });
  await h.client.send(draft({ password: "p", captureId: capture.captureId }));
  const body = h.calls.at(-1)!.body as { screenshot: { data: string; width: number } };
  assert.equal(body.screenshot.width, 1600);
  assert.equal(Buffer.from(body.screenshot.data, "base64").length, 64);

  // Unchecked "include screenshot": captureId null sends none.
  h.advance(61_000);
  const second = h.client.capture(shot);
  h.reply(200, { result: "created", issue: 5 });
  await h.client.send(draft({ captureId: null }));
  assert.equal((h.calls.at(-1)!.body as { screenshot: unknown }).screenshot, null);
  assert.ok(second.captureId);
});

test("a malformed draft is refused before anything is sent", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.client.send(null), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ password: "two words" })), { result: "password" }, "no header could carry it");
  assert.deepEqual(await h.client.send(draft({ password: "пароль" })), { result: "password" });
  assert.deepEqual(await h.client.send(draft({ password: "p", text: "x".repeat(4_001) })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ password: "p", web: { build: "a", serverVersion: "", view: "/sessions/abc", viewport: { width: 1, height: 1, scale: 1 } } })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ password: "p", errors: [{ time: "2026-11-19T11:00:00.000Z", text: "ok", stack: "at x" }] })), { result: "invalid" });
  assert.equal(h.calls.length, 0);
  const off = harness(t, { origin: null });
  assert.equal(off.client.state().available, false);
  assert.deepEqual(await off.client.send(draft({ password: "p" })), { result: "unavailable" });
});
