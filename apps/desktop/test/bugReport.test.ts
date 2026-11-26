import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseFeedback } from "@polyth/contracts/feedback";

import {
  bugReportOrigin,
  createBugReportClient,
  dailyInstallId,
  encodeScreenshot,
  type BugReportClientOptions,
  type CapturedImage,
} from "../src/bugReport.ts";

const NIGHTLY = "1.2.357-nightly";
const NOW = Date.parse("2026-11-25T12:00:00.000Z");
// A JPEG-looking buffer (FF D8 FF E0 …).
const jpegOf = (bytes: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, bytes - 4), 1)]);

test("every build sends feedback to an https or loopback intake unless it is switched off", () => {
  const env = {};
  for (const edition of ["standard", "workstation"] as const) {
    for (const version of [NIGHTLY, "1.2.357"]) {
      assert.equal(bugReportOrigin({ version, edition, env }), "https://reports.polyth.app", `${edition} ${version}`);
      assert.equal(bugReportOrigin({ version, edition, env: { POLYTH_BUG_REPORT_ORIGIN: "off" } }), null, "an administrator's off switch");
    }
  }
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

interface Call { url: string; headers: Headers; body: unknown }

function harness(t: test.TestContext, overrides: Partial<BugReportClientOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-bug-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls: Call[] = [];
  const answers: Array<() => Response | Promise<Response>> = [];
  let clock = NOW;
  const options: BugReportClientOptions = {
    dir,
    origin: "https://reports.example",
    app: {
      version: NIGHTLY, edition: "standard", platform: "darwin", arch: "arm64", osVersion: "24.6.0",
      electron: "39.2.1", chromium: "142.0.7444.59", packaged: true,
    },
    locale: () => "uk",
    desktopSettings: () => ({ "desktop.updateChannel": "nightly", "desktop.closeToTray": true }),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
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
  kind: "bug",
  text: "  The composer jumps when I paste.  ",
  contact: "",
  captureId: null,
  technical: {
    web: { build: "abc123", serverVersion: NIGHTLY, view: "chat", viewport: { width: 1440, height: 900, scale: 2 } },
    settings: { "ui.theme": "midnight", "desktop.updateChannel": "stable", "secret.token": "x" },
    packages: [{ id: "voice-mode", version: "0.3.0" }],
    errors: [],
  },
  profile: null,
  ...overrides,
});

test("feedback needs no password and goes as exactly the wire shape", async (t) => {
  const h = harness(t);
  assert.deepEqual(h.client.state(), { available: true, queued: 0 });
  h.reply(200, { result: "received", ref: 7 });
  assert.deepEqual(await h.client.send(draft()), { result: "received", ref: 7 });
  const [call] = h.calls;
  assert.equal(call!.url, "https://reports.example/v1/feedback");
  assert.equal(call!.headers.get("authorization"), null, "no password, no account");
  const sent = parseFeedback(call!.body, NOW);
  assert.ok(sent, "the body is exactly the wire shape");
  assert.equal(sent.text, "The composer jumps when I paste.");
  assert.equal(sent.kind, "bug");
  assert.equal(sent.screenshot, null);
  assert.deepEqual(sent.consent, { technical: true, screenshot: false, profile: false, contact: false });
  assert.deepEqual(sent.basics, { version: NIGHTLY, channel: "nightly", edition: "standard", locale: "uk" });
  // Renderer settings are ui.* only; desktop.* comes from the desktop.
  assert.deepEqual(sent.technical?.settings, { "ui.theme": "midnight", "desktop.updateChannel": "nightly", "desktop.closeToTray": true });
  assert.equal(sent.install, h.client.capture(null).base.installDaily, "anonymous feedback carries the daily pseudonym");
});

test("an idea can go with only its words: no technical block, no screenshot", async (t) => {
  const h = harness(t);
  h.reply(200, { result: "received", ref: 1 });
  await h.client.send(draft({ kind: "idea", technical: null }));
  const sent = parseFeedback(h.calls[0]!.body, NOW)!;
  assert.equal(sent.technical, null);
  assert.deepEqual(sent.consent, { technical: false, screenshot: false, profile: false, contact: false });
  assert.ok(!JSON.stringify(h.calls[0]!.body).includes("darwin"), "no machine facts without the technical consent");
});

test("a profile or contact makes the pseudonym the stable one the person can reset; the profile is kept, the contact is not", async (t) => {
  const h = harness(t);
  const person = h.client.capture(null).base.installPerson;
  assert.equal(h.client.capture(null).base.savedProfile, null);
  h.reply(200, { result: "received", ref: 1 });
  await h.client.send(draft({ kind: "idea", technical: null, profile: { role: "accountant", experience: "sometimes" }, contact: "ann@example.com" }));
  const sent = parseFeedback(h.calls[0]!.body, NOW)!;
  assert.equal(sent.install, person);
  assert.equal(sent.contact, "ann@example.com");
  assert.deepEqual(h.client.capture(null).base.savedProfile, { role: "accountant", experience: "sometimes" }, "the next sheet opens with it");
  const stored = readFileSync(join(h.dir, "bug-report.json"), "utf8");
  assert.ok(!stored.includes("ann@example.com"), "the contact is typed each time");
  // A new run still has the pseudonym and the profile.
  const again = h.make();
  t.after(() => again.dispose());
  assert.equal(again.capture(null).base.installPerson, person);
});

test("forget erases what this computer sent and starts a new pseudonym", async (t) => {
  const h = harness(t);
  const old = h.client.capture(null).base.installPerson;
  h.reply(200, { result: "received", ref: 1 });
  await h.client.send(draft({ kind: "idea", technical: null, profile: { role: "lawyer", experience: "new" } }));
  assert.deepEqual(await h.client.forget(), { result: "unavailable" }, "an unreachable intake changes nothing");
  assert.equal(h.client.capture(null).base.installPerson, old);

  h.reply(200, { result: "forgotten", count: 1 });
  assert.deepEqual(await h.client.forget(), { result: "forgotten", count: 1 });
  assert.equal(h.calls.at(-1)!.url, "https://reports.example/v1/feedback/forget");
  assert.deepEqual(h.calls.at(-1)!.body, { version: 1, install: old });
  const after = h.client.capture(null).base;
  assert.notEqual(after.installPerson, old);
  assert.equal(after.savedProfile, null);
});

test("this computer does not cap how much feedback it sends", async (t) => {
  const h = harness(t);
  for (let index = 0; index < 15; index += 1) {
    h.reply(200, { result: "received", ref: index + 1 });
    assert.equal((await h.client.send(draft({ text: `Remark ${index}` }))).result, "received", `feedback ${index}, same minute`);
  }
  assert.equal(h.calls.length, 15);
  // The store is only written when it has something to keep; either way it holds no send log.
  const store = existsSync(join(h.dir, "bug-report.json")) ? readFileSync(join(h.dir, "bug-report.json"), "utf8") : "";
  assert.ok(!store.includes("sent"), "no send log is kept");
});

test("an unreachable or busy intake keeps the feedback and sends it later; the daily budget keeps nothing", async (t) => {
  const h = harness(t);
  // fetch throws: no answer queued.
  assert.deepEqual(await h.client.send(draft()), { result: "queued" });
  assert.equal(h.client.state().queued, 1);
  const [file] = readdirSync(join(h.dir, "bug-reports"));
  assert.match(file!, /^[0-9a-f-]{36}\.json$/);

  h.advance(61_000);
  h.reply(503, { result: "unavailable" });
  assert.deepEqual(await h.client.send(draft({ text: "Another remark" })), { result: "queued" });
  assert.equal(h.client.state().queued, 2);

  h.reply(200, { result: "received", ref: 3 });
  h.reply(200, { result: "received", ref: 4 });
  await h.client.flushOutbox();
  assert.equal(h.client.state().queued, 0);
  const ids = h.calls.slice(-2).map((call) => (call.body as { feedbackId: string }).feedbackId);
  assert.equal(new Set(ids).size, 2, "each queued feedback keeps its own id");

  h.reply(429, { result: "rate" });
  assert.deepEqual(await h.client.send(draft({ text: "One more" })), { result: "rate" });
  assert.equal(h.client.state().queued, 0, "a spent budget is told, not queued");
});

test("the outbox drops what the intake will never take and what is too old", async (t) => {
  const h = harness(t);
  await h.client.send(draft());
  h.advance(61_000);
  await h.client.send(draft({ text: "Second" }));
  assert.equal(h.client.state().queued, 2);
  h.reply(400, { result: "invalid" });
  h.reply(503, {});
  await h.client.flushOutbox();
  assert.equal(h.client.state().queued, 1, "the refused one is dropped, the other waits");

  // Older than the intake accepts: dropped on read without a request.
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
  assert.match(capture.base.installDaily, /^[0-9a-f]{32}$/);
  assert.match(capture.base.installPerson, /^[0-9a-f]{32}$/);
  assert.deepEqual(capture.base.settings, { "desktop.updateChannel": "nightly", "desktop.closeToTray": true });

  assert.deepEqual(await h.client.send(draft({ captureId: "another" })), { result: "invalid" });
  h.reply(200, { result: "received", ref: 4 });
  await h.client.send(draft({ captureId: capture.captureId }));
  const body = h.calls.at(-1)!.body as { screenshot: { data: string; width: number }; consent: { screenshot: boolean } };
  assert.equal(body.screenshot.width, 1600);
  assert.equal(body.consent.screenshot, true);
  assert.equal(Buffer.from(body.screenshot.data, "base64").length, 64);

  // Unchecked "include screenshot": captureId null sends none.
  h.advance(61_000);
  const second = h.client.capture(shot);
  h.reply(200, { result: "received", ref: 5 });
  await h.client.send(draft({ captureId: null, text: "Without it" }));
  assert.equal((h.calls.at(-1)!.body as { screenshot: unknown }).screenshot, null);
  assert.ok(second.captureId);
});

test("a marked-up screenshot replaces only its own capture's", async (t) => {
  const h = harness(t);
  const capture = h.client.capture({ jpeg: jpegOf(64), width: 1600, height: 1000 });
  const marked = { jpeg: jpegOf(96), width: 800, height: 500 };
  assert.equal(h.client.annotate("another", marked), null);
  assert.equal(h.client.annotate(capture.captureId, null), null, "bytes that did not decode change nothing");
  assert.deepEqual(h.client.annotate(capture.captureId, marked), {
    dataUrl: `data:image/jpeg;base64,${marked.jpeg.toString("base64")}`, width: 800, height: 500, bytes: 96,
  });
  h.reply(200, { result: "received", ref: 6 });
  await h.client.send(draft({ captureId: capture.captureId }));
  const body = h.calls.at(-1)!.body as { screenshot: { data: string; width: number; height: number } };
  assert.equal(body.screenshot.width, 800);
  assert.equal(body.screenshot.height, 500);
  assert.equal(Buffer.from(body.screenshot.data, "base64").length, 96);
  // Sent: the capture is gone, so a late mark-up is refused.
  assert.equal(h.client.annotate(capture.captureId, marked), null);
});

test("a malformed draft is refused before anything is sent", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.client.send(null), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ text: "x".repeat(4_001) })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ text: "   " })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ kind: "rant" })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ profile: { role: "wizard", experience: "new" } })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ technical: { ...draft().technical, web: { build: "a", serverVersion: "", view: "/sessions/abc", viewport: { width: 1, height: 1, scale: 1 } } } })), { result: "invalid" });
  assert.deepEqual(await h.client.send(draft({ technical: { ...draft().technical, errors: [{ time: "2026-11-25T11:00:00.000Z", text: "ok", stack: "at x" }] } })), { result: "invalid" });
  assert.equal(h.calls.length, 0);
  const off = harness(t, { origin: null });
  assert.equal(off.client.state().available, false);
  assert.deepEqual(await off.client.send(draft()), { result: "unavailable" });
});
