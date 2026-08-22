// WP14 browser service on the fake driver: shared user/agent session with
// serialized actions, stale-frame rejection, downloads denied, redaction,
// newest-frame reconnect, honest missing-engine capability, lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createBrowserService, createFakeDriver, redactObservationText,
  type BrowserFrame, type FakeWeb,
} from "../src/index.ts";

const HOME = "http://127.0.0.1:5173/";

const web = (): FakeWeb => ({
  pages: {
    [HOME]: {
      title: "App",
      text: "welcome home",
      links: { "a#next": `${HOME}next`, "a#dl": `${HOME}download` },
      consoleOnLoad: ["boot ok", "token=sk-abcdef12345 leaked"],
    },
    [`${HOME}next`]: { title: "Next", text: "second page. Authorization: Bearer sk-verysecret123" },
    [`${HOME}hop`]: { title: "Hop", redirectTo: `${HOME}next` },
    [`${HOME}download`]: { title: "DL", download: true },
    [`${HOME}form`]: { title: "Form", text: "login below", passwordFields: { "input#pw": "hunter2" } },
  },
});

const service = (over: Partial<Parameters<typeof createBrowserService>[0]> = {}) =>
  createBrowserService({
    driver: createFakeDriver(web()),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
    resolve: async () => ["93.184.216.34"],
    ...over,
  });

test("missing engine: capability is honest and create refuses", async () => {
  const svc = createBrowserService({ driver: null, unavailableReason: "browser engine unavailable: no Chromium found" });
  const cap = svc.capability();
  assert.equal(cap.available, false);
  assert.equal(cap.engine, null);
  assert.match(cap.reason ?? "", /unavailable/);
  await assert.rejects(() => svc.create({ projectId: "p1" }), /unavailable/);
});

test("create + navigate share one context; frames carry increasing revisions", async () => {
  const svc = service();
  const frames: BrowserFrame[] = [];
  svc.onFrame((f) => frames.push(f));
  const s = await svc.create({ projectId: "p1", sessionId: "sess1", url: HOME });
  assert.equal(s.status, "ready");
  assert.equal(s.url, HOME);
  assert.equal(s.title, "App");
  assert.ok(s.revision >= 1);
  const { session: after } = await svc.action(s.id, { kind: "click", target: { selector: "a#next" } }, "agent");
  assert.equal(after.url, `${HOME}next`);
  assert.ok(after.revision > s.revision);
  assert.ok(frames.length >= 2);
  assert.ok(frames[frames.length - 1]!.revision === after.revision);
  await svc.close(s.id);
});

test("history, device resizing, color scheme, scoped observations, and inspect map through the service", async () => {
  const svc = createBrowserService({
    driver: createFakeDriver({
      pages: {
        [HOME]: { title: "App", text: "welcome", links: { "text:Next": `${HOME}next` } },
        [`${HOME}next`]: { title: "Next", text: "second page token=sk-verysecret123" },
      },
    }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const s = await svc.create({ projectId: "p1", url: HOME, colorScheme: "dark" });
  assert.equal(s.colorScheme, "dark");
  const clicked = await svc.action(s.id, { kind: "click", target: { text: "Next", exact: true } }, "agent");
  assert.equal(clicked.session.url, `${HOME}next`);
  assert.equal((await svc.action(s.id, { kind: "back" }, "agent")).session.url, HOME);
  assert.equal((await svc.action(s.id, { kind: "forward" }, "agent")).session.url, `${HOME}next`);
  const resized = await svc.action(s.id, { kind: "resize", viewport: { width: 390, height: 844 } }, "agent");
  assert.deepEqual(resized.session.viewport, { width: 390, height: 844, deviceScaleFactor: 1 });
  const recolored = await svc.action(s.id, { kind: "color-scheme", colorScheme: "light" }, "user");
  assert.equal(recolored.session.colorScheme, "light");
  const inspected = await svc.action(s.id, { kind: "inspect", selector: "main" }, "agent");
  assert.equal((inspected.result as { selector?: string })?.selector, "main");
  assert.equal((inspected.result as { styles?: { colorScheme?: string } })?.styles?.colorScheme, "light");
  assert.doesNotMatch(String((inspected.result as { text?: string })?.text), /sk-verysecret123/);
  assert.match(String((inspected.result as { text?: string })?.text), /\[redacted\]/i);
  assert.match((await svc.observe(s.id, { selector: "main" })).text, /second page/);
  await svc.close(s.id);
});

test("user and agent actions serialize on one queue with unique action ids", async () => {
  const svc = service();
  const s = await svc.create({ projectId: "p1", url: HOME });
  const [a, b] = await Promise.all([
    svc.action(s.id, { kind: "type", target: { selector: "input#q" }, text: "one" }, "user"),
    svc.action(s.id, { kind: "type", target: { selector: "input#q" }, text: "two" }, "agent"),
  ]);
  assert.notEqual(a.actionId, b.actionId);
  // last write wins because actions ran in order, not interleaved
  const obs = await svc.observe(s.id);
  assert.match(obs.text, /input#q=two/);
  await svc.close(s.id);
});

test("stale point coordinates are rejected before touching the page", async () => {
  const svc = service();
  const s = await svc.create({ projectId: "p1", url: HOME });
  const staleRevision = s.revision;
  await svc.action(s.id, { kind: "click", target: { selector: "a#next" } }, "user"); // bumps revision
  await assert.rejects(
    () => svc.action(s.id, { kind: "click", target: { point: { x: 5, y: 5 }, frameRevision: staleRevision } }, "agent"),
    (e: Error & { code?: string }) => e.code === "stale-frame",
  );
  // current-revision point clicks pass validation
  const cur = svc.get(s.id)!;
  await svc.action(s.id, { kind: "click", target: { point: { x: 5, y: 5 }, frameRevision: cur.revision } }, "agent");
  await svc.close(s.id);
});

test("agent pause blocks agent but not user; resume restores", async () => {
  const svc = service();
  const s = await svc.create({ projectId: "p1", url: HOME });
  svc.pauseAgent(s.id, true);
  await assert.rejects(
    () => svc.navigate(s.id, `${HOME}next`, "agent"),
    (e: Error & { code?: string }) => e.code === "agent-paused",
  );
  await svc.navigate(s.id, `${HOME}next`, "user"); // user unaffected
  svc.pauseAgent(s.id, false);
  await svc.navigate(s.id, HOME, "agent");
  await svc.close(s.id);
});

test("downloads are denied and surfaced as events", async () => {
  const svc = service();
  const events: string[] = [];
  svc.onEvent((e) => events.push(e.kind));
  const s = await svc.create({ projectId: "p1", url: HOME });
  await assert.rejects(
    () => svc.navigate(s.id, `${HOME}download`, "user"),
    (e: Error & { code?: string }) => e.code === "download-blocked",
  );
  assert.ok(events.includes("download-blocked"));
  await svc.close(s.id);
});

test("redirect hops re-run policy; blocked origins never land", async () => {
  const svc = createBrowserService({
    driver: createFakeDriver({
      pages: {
        [HOME]: { title: "App" },
        [`${HOME}evil`]: { title: "Evil", redirectTo: "http://169.254.169.254/latest/meta-data" },
      },
    }),
    allowedOrigins: () => ["http://127.0.0.1:5173"],
  });
  const s = await svc.create({ projectId: "p1", url: HOME });
  await assert.rejects(
    () => svc.navigate(s.id, `${HOME}evil`, "user"),
    (e: Error & { code?: string }) => e.code === "blocked-private",
  );
  assert.equal(svc.get(s.id)!.url, HOME); // still on the safe page
  await svc.close(s.id);
});

test("observations and console lines are redacted; password values never appear", async () => {
  const svc = service();
  const runtimeMessages: string[] = [];
  svc.onEvent((event) => {
    if (event.message) runtimeMessages.push(event.message);
  });
  const s = await svc.create({ projectId: "p1", url: HOME });
  await svc.navigate(s.id, `${HOME}next`, "user");
  const obs = await svc.observe(s.id);
  assert.ok(!obs.text.includes("sk-verysecret123"));
  assert.match(obs.text, /\[redacted\]/);
  const logs = svc.console(s.id);
  assert.ok(logs.length >= 1);
  assert.ok(logs.every((l) => !l.message.includes("sk-abcdef12345")));
  assert.ok(runtimeMessages.every((message) => !message.includes("sk-abcdef12345")));
  assert.ok(runtimeMessages.some((message) => /\[redacted\]/i.test(message)));
  // password form: typing into a password field never shows up in observe
  await svc.navigate(s.id, `${HOME}form`, "user");
  await svc.action(s.id, { kind: "type", target: { selector: "input#pw" }, text: "hunter2" }, "user");
  const formObs = await svc.observe(s.id);
  assert.ok(!formObs.text.includes("hunter2"));
  await svc.close(s.id);
});

test("latestFrame supports reconnect-at-revision (newest only)", async () => {
  const svc = service();
  const s = await svc.create({ projectId: "p1", url: HOME });
  const rev1 = svc.get(s.id)!.revision;
  assert.ok(svc.latestFrame(s.id, 0));
  assert.equal(svc.latestFrame(s.id, rev1), null); // caller already has it
  await svc.navigate(s.id, `${HOME}next`, "user");
  const resumed = svc.latestFrame(s.id, rev1);
  assert.ok(resumed);
  assert.ok(resumed!.revision > rev1);
  await svc.close(s.id);
});

test("close destroys state; further calls fail with not-found; closeAll sweeps", async () => {
  const svc = service();
  const s = await svc.create({ projectId: "p1", url: HOME });
  await svc.close(s.id);
  assert.equal(svc.latestFrame(s.id), null);
  await assert.rejects(() => svc.observe(s.id), (e: Error & { code?: string }) => e.code === "not-found");
  const s2 = await svc.create({ projectId: "p1", url: HOME });
  await svc.closeAll();
  assert.equal(svc.get(s2.id)?.status ?? "closed", "closed");
});

test("session lifetime cap closes the browser automatically", async () => {
  const svc = service({ maxLifetimeMs: 30 });
  const s = await svc.create({ projectId: "p1", url: HOME });
  await new Promise((r) => setTimeout(r, 80));
  await assert.rejects(() => svc.observe(s.id), (e: Error & { code?: string }) => e.code === "not-found");
});

test("session cap limits concurrent contexts", async () => {
  const svc = service({ maxSessions: 1 });
  await svc.create({ projectId: "p1", url: HOME });
  await assert.rejects(() => svc.create({ projectId: "p1" }), /too many/);
  await svc.closeAll();
});

test("redactObservationText scrubs common credential shapes", () => {
  const out = redactObservationText(
    "Authorization: Bearer abc12345678 cookie: sid=1 ghp_0123456789012345678901234 password=hunter2 AKIAABCDEFGHIJKLMNOP",
    { secrets: ["customsecret"] },
  );
  assert.ok(!out.includes("abc12345678"));
  assert.ok(!out.includes("sid=1"));
  assert.ok(!out.includes("ghp_0123456789012345678901234"));
  assert.ok(!out.includes("hunter2"));
  assert.ok(!out.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.equal(redactObservationText("keep customsecret out", { secrets: ["customsecret"] }).includes("customsecret"), false);
  assert.equal(redactObservationText("x".repeat(30), { maxChars: 10 }).startsWith("xxxxxxxxxx"), true);
});
