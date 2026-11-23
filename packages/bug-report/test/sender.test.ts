import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServerReporter, serverBugReportOrigin, type ServerReporterOptions } from "../src/sender.ts";
import { bugReportRoutes } from "../src/serverEntry.ts";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ORIGIN = "https://reports.example.test";
// The smallest base64 that starts like a JPEG (FF D8 FF E0).
const JPEG = "/9j/4AAQ";

interface Sent { url: string; authorization: string; body: Record<string, any> }

function relay(answers: Array<{ status: number; body?: unknown } | "offline">) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const answer = answers.shift() ?? { status: 200, body: { result: "created", issue: 1 } };
    if (answer === "offline") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    sent.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, any>,
    });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

function reporter(fetch: typeof globalThis.fetch, overrides: Partial<ServerReporterOptions> = {}) {
  const dir = overrides.dir ?? mkdtempSync(join(tmpdir(), "bug-report-server-"));
  const value = createServerReporter({
    dir, origin: ORIGIN, version: "1.2.371-nightly", platform: "linux", arch: "x64",
    fetch, now: () => NOW, log: () => {}, ...overrides,
  });
  return { dir, reporter: value };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: "  The sidebar overlaps the chat  ",
    contact: "@octo-cat",
    client: { platform: "ios", browser: "Safari 18", locale: "uk" },
    web: { build: "abc123", serverVersion: "1.2.371-nightly", view: "chat", viewport: { width: 390, height: 844, scale: 3 } },
    settings: { "ui.theme": "midnight", "desktop.closeToTray": true },
    packages: [{ id: "voice-mode", version: "0.3.0" }],
    errors: [],
    screenshot: { type: "image/jpeg", width: 1170, height: 1600, data: JPEG },
    ...overrides,
  };
}

test("only a nightly standard server that is not hosted multi-tenant reports", () => {
  const base = { version: "1.2.371-nightly", workstation: false, multiTenant: false, env: {} };
  assert.equal(serverBugReportOrigin(base), "https://reports.polyth.app");
  assert.equal(serverBugReportOrigin({ ...base, version: "1.2.0" }), null, "stable");
  assert.equal(serverBugReportOrigin({ ...base, version: undefined }), null, "a host without a version");
  assert.equal(serverBugReportOrigin({ ...base, workstation: true }), null, "workstation");
  assert.equal(serverBugReportOrigin({ ...base, multiTenant: true }), null, "hosted multi-tenant");
  assert.equal(serverBugReportOrigin({ ...base, env: { POLYTH_BUG_REPORT_ORIGIN: "off" } }), null);
  assert.equal(serverBugReportOrigin({ ...base, version: "1.2.0", env: { POLYTH_BUG_REPORT: "1" } }), "https://reports.polyth.app");
  assert.equal(serverBugReportOrigin({ ...base, env: { POLYTH_BUG_REPORT_ORIGIN: "http://127.0.0.1:8787" } }), "http://127.0.0.1:8787");
  assert.equal(serverBugReportOrigin({ ...base, env: { POLYTH_BUG_REPORT_ORIGIN: "http://relay.example" } }), null, "plain http off loopback");
});

test("the server sends the page's draft as a browser report and speaks for its own version and OS", async () => {
  const { fetch, sent } = relay([{ status: 200, body: { result: "created", issue: 7 } }]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual({ ...r.state(), base: undefined }, { available: true, needsPassword: true, queued: 0, base: undefined });
  assert.equal(r.state().base?.serverPlatform, "linux");

  assert.deepEqual(await r.send(draft()), { result: "password" }, "no password yet");
  const outcome = await r.send(draft({
    password: "tester-pass",
    // A page cannot claim another version or smuggle desktop facts.
    app: { version: "9.9.9-nightly" },
    client: { platform: "ios", browser: "Safari 18", locale: "uk", version: "9.9.9-nightly" },
  }));
  assert.deepEqual(outcome, { result: "created", issue: 7 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, `${ORIGIN}/v1/report`);
  assert.equal(sent[0]!.authorization, "Bearer tester-pass");
  const body = sent[0]!.body;
  assert.deepEqual(body.app, {
    client: "browser", version: "1.2.371-nightly", channel: "nightly", edition: "standard", platform: "ios",
    browser: "Safari 18", serverPlatform: "linux", serverArch: "x64", locale: "uk",
  });
  assert.deepEqual(body.settings, { "ui.theme": "midnight" }, "a page speaks only for ui.* settings");
  assert.equal(body.text, "The sidebar overlaps the chat");
  assert.equal(body.contact, "octo-cat");
  assert.equal(body.screenshot.data, JPEG);
  assert.equal(body.install, r.state().base?.install);
  assert.ok(!("password" in body), "the password travels only in the header");

  // Accepted: kept on the server, 0600, and asked no more.
  assert.equal(r.state().needsPassword, false);
  assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600);
  assert.ok(await r.send(draft()), "a second report needs no password");
  assert.equal(sent[1]!.authorization, "Bearer tester-pass");
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a wrong typed password is never kept; a kept one the relay refuses is forgotten", async () => {
  const { fetch } = relay([{ status: 401 }, { status: 200, body: { result: "created", issue: 1 } }, { status: 401 }]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual(await r.send(draft({ password: "wrong" })), { result: "password" });
  assert.equal(r.state().needsPassword, true);
  assert.deepEqual(await r.send(draft({ password: "right" })), { result: "created", issue: 1 });
  assert.equal(r.state().needsPassword, false);
  assert.deepEqual(await r.send(draft()), { result: "password" }, "rotated on the relay");
  assert.equal(r.state().needsPassword, true);
  assert.doesNotMatch(readFileSync(join(dir, "state.json"), "utf8"), /right/);
  assert.deepEqual(await r.send(draft({ password: "has space" })), { result: "password" }, "a header cannot carry it");
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("an unreachable or busy relay queues the report on the server and it goes later", async () => {
  const { fetch, sent } = relay(["offline", { status: 503 }, { status: 200, body: { result: "created", issue: 3 } }, { status: 200, body: { result: "added", issue: 3 } }]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual(await r.send(draft({ password: "tester-pass" })), { result: "queued" });
  assert.deepEqual(await r.send(draft()), { result: "queued" }, "the unverified password was kept for the queue");
  assert.equal(r.state().queued, 2);
  await r.flushOutbox();
  assert.equal(r.state().queued, 0);
  assert.equal(sent.length, 3, "one refused with 503, then both from the outbox");
  assert.deepEqual(readdirSync(join(dir, "outbox")), []);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("an unverified password typed while the relay is down never replaces a kept one", async () => {
  const { fetch, sent } = relay([{ status: 200, body: { result: "created", issue: 1 } }, "offline", { status: 200, body: { result: "created", issue: 2 } }]);
  const { dir, reporter: r } = reporter(fetch);
  await r.send(draft({ password: "good" }));
  assert.deepEqual(await r.send(draft({ password: "junk" })), { result: "queued" });
  await r.flushOutbox();
  assert.equal(sent.at(-1)!.authorization, "Bearer good");
  assert.match(readFileSync(join(dir, "state.json"), "utf8"), /"good"/);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a draft outside the wire shape is refused before anything is sent", async () => {
  const { fetch, sent } = relay([]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual(await r.send(draft({ password: "p", screenshot: { type: "image/png", width: 1, height: 1, data: JPEG } })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ password: "p", client: { platform: "ios", browser: "Mozilla/5.0 (iPhone)", locale: "uk" } })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ password: "p", web: { view: "/sessions/abc" } })), { result: "invalid" });
  assert.deepEqual(await r.send("nope"), { result: "invalid" });
  assert.equal(sent.length, 0);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a server that does not report says so and sends nothing", async () => {
  const { fetch, sent } = relay([]);
  const { dir, reporter: r } = reporter(fetch, { origin: null });
  assert.equal(r.state().available, false);
  assert.equal(r.state().base, null);
  assert.deepEqual(await r.send(draft({ password: "p" })), { result: "unavailable" });
  const odd = reporter(fetch, { platform: "freebsd" });
  assert.equal(odd.reporter.state().available, false, "the wire has no server platform for it");
  assert.equal(sent.length, 0);
  r.dispose();
  odd.reporter.dispose();
  rmSync(dir, { recursive: true, force: true });
  rmSync(odd.dir, { recursive: true, force: true });
});

test("routes: state, send and the off answer", async () => {
  const call = async (handler: ReturnType<typeof bugReportRoutes>, path: string, method: string, input: unknown = {}) => {
    let answered: { code: number; body: unknown } | null = null;
    const handled = await handler({
      path, method,
      json: (code: number, body: unknown) => { answered = { code, body }; },
      body: async () => input as Record<string, unknown>,
    } as unknown as Parameters<ReturnType<typeof bugReportRoutes>>[0]);
    return { handled, answered: answered as { code: number; body: any } | null };
  };
  const off = bugReportRoutes(() => null);
  assert.deepEqual((await call(off, "/api/bug-report/state", "GET")).answered, { code: 200, body: { available: false, needsPassword: false, queued: 0, base: null } });
  assert.deepEqual((await call(off, "/api/bug-report/send", "POST")).answered, { code: 503, body: { result: "unavailable" } });
  assert.equal((await call(off, "/api/bug-report/other", "GET")).handled, false);

  const { fetch } = relay([{ status: 200, body: { result: "created", issue: 9 } }]);
  const { dir, reporter: r } = reporter(fetch);
  const on = bugReportRoutes(() => r);
  assert.equal((await call(on, "/api/bug-report/state", "GET")).answered?.body.available, true);
  assert.deepEqual((await call(on, "/api/bug-report/send", "POST", draft({ password: "p" }))).answered, { code: 200, body: { result: "created", issue: 9 } });
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});
