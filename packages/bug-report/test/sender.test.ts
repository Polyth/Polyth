import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServerReporter, serverBugReportOrigin, type ServerReporterOptions } from "../src/sender.ts";
import { bugReportRoutes } from "../src/serverEntry.ts";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const ORIGIN = "https://feedback.example.test";
// The smallest base64 that starts like a JPEG (FF D8 FF E0).
const JPEG = "/9j/4AAQ";

interface Sent { url: string; headers: Headers; body: Record<string, any> }

function intake(answers: Array<{ status: number; body?: unknown } | "offline">) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const answer = answers.shift() ?? { status: 200, body: { result: "received", ref: 1 } };
    if (answer === "offline") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    sent.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, any> });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

function reporter(fetch: typeof globalThis.fetch, overrides: Partial<ServerReporterOptions> = {}) {
  const dir = overrides.dir ?? mkdtempSync(join(tmpdir(), "bug-report-server-"));
  const value = createServerReporter({
    dir, origin: ORIGIN, version: "1.2.380", platform: "linux", arch: "x64",
    fetch, now: () => NOW, log: () => {}, ...overrides,
  });
  return { dir, reporter: value };
}

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "bug",
    text: "  The sidebar overlaps the chat  ",
    contact: "",
    client: { platform: "ios", browser: "Safari 18", locale: "uk" },
    technical: {
      web: { build: "abc123", serverVersion: "1.2.380", view: "chat", viewport: { width: 390, height: 844, scale: 3 } },
      settings: { "ui.theme": "midnight", "desktop.closeToTray": true },
      packages: [{ id: "voice-mode", version: "0.3.0" }],
      errors: [],
    },
    profile: null,
    screenshot: { type: "image/jpeg", width: 1170, height: 1600, data: JPEG },
    ...overrides,
  };
}

test("any standard server reports unless it is a workstation, hosted multi-tenant or switched off", () => {
  const base = { version: "1.2.380", workstation: false, multiTenant: false, env: {} };
  assert.equal(serverBugReportOrigin(base), "https://reports.polyth.app", "a stable server too");
  assert.equal(serverBugReportOrigin({ ...base, version: "1.2.371-nightly" }), "https://reports.polyth.app");
  assert.equal(serverBugReportOrigin({ ...base, version: undefined }), null, "a host without a version");
  assert.equal(serverBugReportOrigin({ ...base, workstation: true }), null, "workstation");
  assert.equal(serverBugReportOrigin({ ...base, multiTenant: true }), null, "hosted multi-tenant");
  assert.equal(serverBugReportOrigin({ ...base, env: { POLYTH_BUG_REPORT_ORIGIN: "off" } }), null);
  assert.equal(serverBugReportOrigin({ ...base, env: { POLYTH_BUG_REPORT_ORIGIN: "http://127.0.0.1:8787" } }), "http://127.0.0.1:8787");
  assert.equal(serverBugReportOrigin({ ...base, env: { POLYTH_BUG_REPORT_ORIGIN: "http://relay.example" } }), null, "plain http off loopback");
});

test("the server sends the page's draft as browser feedback and speaks for its own version and OS", async () => {
  const { fetch, sent } = intake([{ status: 200, body: { result: "received", ref: 7 } }]);
  const { dir, reporter: r } = reporter(fetch);
  assert.equal(r.state().available, true);
  assert.equal(r.state().base?.serverPlatform, "linux");

  const outcome = await r.send(draft({
    // A page cannot claim another version or smuggle desktop facts.
    app: { version: "9.9.9-nightly" },
    client: { platform: "ios", browser: "Safari 18", locale: "uk", version: "9.9.9-nightly" },
  }));
  assert.deepEqual(outcome, { result: "received", ref: 7 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, `${ORIGIN}/v1/feedback`);
  assert.equal(sent[0]!.headers.get("authorization"), null, "no password, no account");
  const body = sent[0]!.body;
  assert.deepEqual(body.technical.app, {
    client: "browser", version: "1.2.380", channel: "stable", edition: "standard", platform: "ios",
    browser: "Safari 18", serverPlatform: "linux", serverArch: "x64", locale: "uk",
  });
  assert.deepEqual(body.basics, { version: "1.2.380", channel: "stable", edition: "standard", locale: "uk" });
  assert.deepEqual(body.technical.settings, { "ui.theme": "midnight" }, "a page speaks only for ui.* settings");
  assert.equal(body.text, "The sidebar overlaps the chat");
  assert.equal(body.kind, "bug");
  assert.equal(body.screenshot.data, JPEG);
  assert.deepEqual(body.consent, { technical: true, screenshot: true, profile: false, contact: false });
  assert.equal(body.install, r.state().base?.installDaily, "anonymous feedback carries the daily pseudonym");
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a person who shares a profile or contact is one resettable pseudonym; nothing else is kept", async () => {
  const { fetch, sent } = intake([]);
  const { dir, reporter: r } = reporter(fetch);
  const person = r.state().base!.installPerson;
  assert.notEqual(person, r.state().base!.installDaily);
  assert.equal(r.state().base?.savedProfile, null);

  await r.send(draft({ kind: "idea", technical: null, screenshot: null, profile: { role: "lawyer", experience: "new" } }));
  assert.equal(sent[0]!.body.install, person);
  assert.deepEqual(sent[0]!.body.consent, { technical: false, screenshot: false, profile: true, contact: false });
  assert.equal(sent[0]!.body.technical, null);
  assert.deepEqual(r.state().base?.savedProfile, { role: "lawyer", experience: "new" }, "the next sheet opens with it");

  await r.send(draft({ kind: "pain", technical: null, screenshot: null, contact: "ann@example.com" }));
  assert.equal(sent[1]!.body.install, person, "a contact alone is enough to be known");
  assert.equal(sent[1]!.body.contact, "ann@example.com");

  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(state).sort(), ["person", "profile", "secret"], "the contact is not stored");
  assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("forget erases what was sent under the person's pseudonym and starts a new one", async () => {
  const { fetch, sent } = intake([{ status: 200, body: { result: "received", ref: 1 } }, "offline", { status: 200, body: { result: "forgotten", count: 2 } }, { status: 503 }]);
  const { dir, reporter: r } = reporter(fetch);
  const old = r.state().base!.installPerson;
  await r.send(draft({ kind: "idea", technical: null, screenshot: null, profile: { role: "lawyer", experience: "new" } }));
  assert.deepEqual(await r.send(draft({ kind: "idea", text: "A second thought", technical: null, screenshot: null, profile: { role: "lawyer", experience: "new" } })), { result: "queued" });
  assert.equal(r.state().queued, 1);

  assert.deepEqual(await r.forget(), { result: "forgotten", count: 2 });
  assert.deepEqual(sent.at(-1)!.body, { version: 1, install: old });
  assert.equal(sent.at(-1)!.url, `${ORIGIN}/v1/feedback/forget`);
  assert.notEqual(r.state().base!.installPerson, old);
  assert.equal(r.state().base?.savedProfile, null, "the saved profile goes too");
  assert.equal(r.state().queued, 0, "what waited under the old pseudonym goes too");

  const kept = r.state().base!.installPerson;
  assert.deepEqual(await r.forget(), { result: "unavailable" }, "an unreachable intake changes nothing");
  assert.equal(r.state().base!.installPerson, kept);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("an unreachable or busy intake queues the feedback on the server and it goes later", async () => {
  const { fetch, sent } = intake(["offline", { status: 503 }, { status: 200, body: { result: "received", ref: 3 } }, { status: 200, body: { result: "received", ref: 4 } }]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual(await r.send(draft()), { result: "queued" });
  assert.deepEqual(await r.send(draft({ text: "Another remark" })), { result: "queued" });
  assert.equal(r.state().queued, 2);
  await r.flushOutbox();
  assert.equal(r.state().queued, 0);
  assert.equal(sent.length, 3, "one refused with 503, then both from the outbox");
  assert.deepEqual(readdirSync(join(dir, "outbox")), []);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("the daily budget answers rate and keeps nothing waiting", async () => {
  const { fetch } = intake([{ status: 429, body: { result: "rate" } }]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual(await r.send(draft()), { result: "rate" });
  assert.equal(r.state().queued, 0);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a draft outside the wire shape is refused before anything is sent", async () => {
  const { fetch, sent } = intake([]);
  const { dir, reporter: r } = reporter(fetch);
  assert.deepEqual(await r.send(draft({ screenshot: { type: "image/png", width: 1, height: 1, data: JPEG } })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ client: { platform: "ios", browser: "Mozilla/5.0 (iPhone)", locale: "uk" } })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ technical: { ...(draft().technical as object), web: { view: "/sessions/abc" } } })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ text: "   " })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ kind: "rant" })), { result: "invalid" });
  assert.deepEqual(await r.send(draft({ profile: { role: "wizard", experience: "new" } })), { result: "invalid" });
  assert.deepEqual(await r.send("nope"), { result: "invalid" });
  assert.equal(sent.length, 0);
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("a server that does not send says so and sends nothing", async () => {
  const { fetch, sent } = intake([]);
  const { dir, reporter: r } = reporter(fetch, { origin: null });
  assert.equal(r.state().available, false);
  assert.equal(r.state().base, null);
  assert.deepEqual(await r.send(draft()), { result: "unavailable" });
  const odd = reporter(fetch, { platform: "freebsd" });
  assert.equal(odd.reporter.state().available, false, "the wire has no server platform for it");
  assert.equal(sent.length, 0);
  r.dispose();
  odd.reporter.dispose();
  rmSync(dir, { recursive: true, force: true });
  rmSync(odd.dir, { recursive: true, force: true });
});

test("routes: state, send, forget and the off answer", async () => {
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
  assert.deepEqual((await call(off, "/api/bug-report/state", "GET")).answered, { code: 200, body: { available: false, queued: 0, base: null } });
  assert.deepEqual((await call(off, "/api/bug-report/send", "POST")).answered, { code: 503, body: { result: "unavailable" } });
  assert.deepEqual((await call(off, "/api/bug-report/forget", "POST")).answered, { code: 200, body: { result: "unavailable" } });
  assert.equal((await call(off, "/api/bug-report/other", "GET")).handled, false);

  const { fetch } = intake([{ status: 200, body: { result: "received", ref: 9 } }]);
  const { dir, reporter: r } = reporter(fetch);
  const on = bugReportRoutes(() => r);
  assert.equal((await call(on, "/api/bug-report/state", "GET")).answered?.body.available, true);
  assert.deepEqual((await call(on, "/api/bug-report/send", "POST", draft())).answered, { code: 200, body: { result: "received", ref: 9 } });
  r.dispose();
  rmSync(dir, { recursive: true, force: true });
});
