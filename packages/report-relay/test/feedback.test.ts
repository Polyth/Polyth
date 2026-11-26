import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { FeedbackPayload } from "@polyth/contracts/feedback";

import { createReportRelay } from "../src/index.ts";
import { INBOX_TOKEN, fixture, screenshot, serve, uuid } from "./support.ts";

const feedback = (n: number, overrides: Partial<FeedbackPayload> = {}): FeedbackPayload => ({
  version: 1,
  feedbackId: uuid(n),
  install: String(n).padStart(32, "0"),
  createdAt: new Date().toISOString(),
  kind: "idea",
  text: `Idea number ${n}`,
  contact: "",
  consent: { technical: false, screenshot: false, profile: false, contact: false },
  basics: { version: "1.2.3", channel: "stable", edition: "standard", locale: "uk" },
  technical: null,
  profile: null,
  screenshot: null,
  ...overrides,
});

const withEverything = (n: number): FeedbackPayload => feedback(n, {
  kind: "bug",
  text: "The composer jumps @someone see #12",
  contact: "ann@example.com",
  consent: { technical: true, screenshot: true, profile: true, contact: true },
  technical: {
    app: {
      version: "1.2.3", channel: "stable", edition: "standard", platform: "darwin", arch: "arm64",
      osVersion: "24.6.0", electron: "39.2.1", chromium: "142.0.0.0", packaged: true, locale: "uk",
    },
    web: { build: "b1", serverVersion: "", view: "chat", viewport: { width: 1440, height: 900, scale: 2 } },
    settings: { "ui.theme": "dark" },
    packages: [{ id: "git", version: "1.0.0" }],
    errors: [],
  },
  profile: { role: "lawyer", experience: "new" },
  screenshot: screenshot(),
});

const send = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const inbox = (url: string, path: string, init: RequestInit = {}, token: string | null = INBOX_TOKEN) =>
  fetch(`${url}${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });

test("anyone can leave feedback: no password, no account, no version check", async (t) => {
  const setup = await serve({ allowVersion: () => false });
  t.after(() => setup.close());
  const response = await send(setup.url, "/v1/feedback", feedback(1));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "received", ref: 1 });
  assert.equal(setup.github.calls, 0, "feedback never reaches GitHub by itself");
  for (const body of ["{", "{}", { ...feedback(2), extra: 1 }, { ...feedback(2), text: "  " }]) {
    const bad = await send(setup.url, "/v1/feedback", body);
    assert.equal(bad.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await fetch(`${setup.url}/v1/feedback`, { method: "POST", body: "{}" })).status, 400, "content type");
  assert.equal((await fetch(`${setup.url}/v1/feedback`)).status, 404, "GET is not a route");
});

test("a repeat of the same id or the same words from one install stores nothing new", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  assert.deepEqual(await (await send(setup.url, "/v1/feedback", feedback(1))).json(), { result: "received", ref: 1 });
  assert.deepEqual(await (await send(setup.url, "/v1/feedback", feedback(1))).json(), { result: "received", ref: 1 });
  assert.deepEqual(await (await send(setup.url, "/v1/feedback", feedback(9, { install: feedback(1).install, text: "idea  NUMBER 1" }))).json(), { result: "received", ref: 1 });
  assert.deepEqual(await (await send(setup.url, "/v1/feedback", feedback(2))).json(), { result: "received", ref: 2 });
  const page = await (await inbox(setup.url, "/v1/inbox")).json() as { total: number };
  assert.equal(page.total, 2);
});

test("stage 1 has one service-wide daily budget and nothing per person", async (t) => {
  const setup = await serve({ limits: { feedbackDay: 3 } });
  t.after(() => setup.close());
  for (let n = 1; n <= 3; n++) assert.equal((await send(setup.url, "/v1/feedback", feedback(n))).status, 200);
  const over = await send(setup.url, "/v1/feedback", feedback(4));
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { result: "rate" });
});

test("the kill switch refuses feedback too", async (t) => {
  const setup = await serve({ off: true });
  t.after(() => setup.close());
  const response = await send(setup.url, "/v1/feedback", feedback(1));
  assert.equal(response.status, 503);
});

test("the inbox needs its token; a wrong token is counted and locks the source out", async (t) => {
  const setup = await serve({ limits: { passwordFailures: 2 } });
  t.after(() => setup.close());
  await send(setup.url, "/v1/feedback", feedback(1));
  assert.equal((await inbox(setup.url, "/v1/inbox", {}, null)).status, 401);
  assert.equal((await inbox(setup.url, "/v1/inbox", {}, "wrong-token")).status, 401);
  assert.equal((await inbox(setup.url, "/v1/inbox", {}, "wrong-token")).status, 401);
  assert.equal((await inbox(setup.url, "/v1/inbox", {}, INBOX_TOKEN)).status, 429, "locked out even with the right token");
});

test("the team reads, filters, summarises and triages;", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  await send(setup.url, "/v1/feedback", withEverything(1));
  await send(setup.url, "/v1/feedback", feedback(2, { kind: "praise", profile: { role: "accountant", experience: "daily" }, consent: { technical: false, screenshot: false, profile: true, contact: false } }));
  await send(setup.url, "/v1/feedback", feedback(3));

  const all = await (await inbox(setup.url, "/v1/inbox")).json() as { total: number; items: Array<{ ref: number; kind: string; screenshot?: unknown; technical?: unknown }> };
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((item) => item.ref), [3, 2, 1], "newest first");
  assert.ok(all.items.every((item) => item.screenshot === undefined && item.technical === undefined), "the list carries no bytes and no technical block");

  const lawyers = await (await inbox(setup.url, "/v1/inbox?role=lawyer")).json() as { total: number };
  assert.equal(lawyers.total, 1);
  assert.equal(((await (await inbox(setup.url, "/v1/inbox?kind=praise")).json()) as { total: number }).total, 1);
  assert.equal((await inbox(setup.url, "/v1/inbox?kind=rant")).status, 400);
  assert.equal((await inbox(setup.url, "/v1/inbox?limit=0")).status, 400);

  const summary = await (await inbox(setup.url, "/v1/inbox/summary")).json() as Record<string, any>;
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byKind, { bug: 1, praise: 1, idea: 1 });
  assert.deepEqual(summary.byRole, { lawyer: 1, accountant: 1 });
  assert.equal(summary.byChannel.stable, 3);
  assert.equal(summary.installs, 3);

  const detail = await (await inbox(setup.url, "/v1/inbox/1")).json() as Record<string, any>;
  assert.equal(detail.technical.web.view, "chat");
  assert.equal(detail.contact, "ann@example.com");
  assert.equal(detail.hasScreenshot, true);
  const image = await inbox(setup.url, "/v1/inbox/1/screenshot");
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal((await image.arrayBuffer()).byteLength, 10);
  assert.equal((await inbox(setup.url, "/v1/inbox/3/screenshot")).status, 404);
  assert.equal((await inbox(setup.url, "/v1/inbox/99")).status, 404);

  const updated = await inbox(setup.url, "/v1/inbox/1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "seen", note: "asked for a repro" }) });
  assert.equal(updated.status, 200);
  const after = await updated.json() as { status: string; note: string };
  assert.deepEqual([after.status, after.note], ["seen", "asked for a repro"]);
  for (const body of [{ status: "bogus" }, {}, { status: "done", extra: 1 }, { note: 5 }]) {
    const bad = await inbox(setup.url, "/v1/inbox/1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(bad.status, 400, JSON.stringify(body));
  }
  assert.equal((await inbox(setup.url, "/v1/inbox?status=seen")).status, 200);
});

test("filing to GitHub sends the words and the build, never the contact, profile or install", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  const body = withEverything(1);
  await send(setup.url, "/v1/feedback", body);
  const filed = await inbox(setup.url, "/v1/inbox/1/github", { method: "POST" });
  assert.equal(filed.status, 200);
  assert.deepEqual(await filed.json(), { result: "filed", issue: 100 });

  const issue = setup.github.issue(100);
  assert.ok(issue);
  assert.equal(issue.title, "[1.2.3] Bug: The composer jumps @‍someone see #‍12");
  assert.deepEqual(issue.labels, ["feedback", "kind:bug", "v1.2.3", "platform:darwin", "has-screenshot"]);
  assert.match(issue.body, /<!-- polyth-feedback ref=1 -->/);
  assert.match(issue.body, /!\[screenshot\]\(https:\/\/github\.com\/Polyth\/private-nightly-reports\/blob\/attachments\/reports\/\d{4}-\d{2}-\d{2}\/fb-1\/screenshot\.jpg\?raw=true\)/);
  for (const secret of ["ann@example.com", "lawyer", body.install]) assert.ok(!issue.body.includes(secret), `${secret} stays out of GitHub`);
  assert.equal(setup.github.uploads.length, 1);

  const again = await inbox(setup.url, "/v1/inbox/1/github", { method: "POST" });
  assert.deepEqual(await again.json(), { result: "filed", issue: 100 });
  assert.equal(setup.github.issues.length, 1, "a second click files nothing");
  const detail = await (await inbox(setup.url, "/v1/inbox/1")).json() as { githubIssue: number; status: string };
  assert.deepEqual([detail.githubIssue, detail.status], [100, "planned"]);
});

test("GitHub failing leaves the feedback untouched and answers unavailable", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  await send(setup.url, "/v1/feedback", feedback(1, { kind: "bug" }));
  setup.github.failures = 1;
  assert.equal((await inbox(setup.url, "/v1/inbox/1/github", { method: "POST" })).status, 503);
  const detail = await (await inbox(setup.url, "/v1/inbox/1")).json() as { githubIssue: number | null; status: string };
  assert.deepEqual([detail.githubIssue, detail.status], [null, "new"]);
  assert.equal((await inbox(setup.url, "/v1/inbox/1/github", { method: "POST" })).status, 200, "a later click works");
  assert.equal((await inbox(setup.url, "/v1/inbox/42/github", { method: "POST" })).status, 404);
});

test("forget erases everything one install pseudonym sent", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  await send(setup.url, "/v1/feedback", feedback(1));
  await send(setup.url, "/v1/feedback", feedback(2, { install: feedback(1).install }));
  await send(setup.url, "/v1/feedback", feedback(3));
  const forgotten = await send(setup.url, "/v1/feedback/forget", { version: 1, install: feedback(1).install });
  assert.deepEqual(await forgotten.json(), { result: "forgotten", count: 2 });
  assert.equal(((await (await inbox(setup.url, "/v1/inbox")).json()) as { total: number }).total, 1);
  assert.equal((await send(setup.url, "/v1/feedback/forget", { version: 1, install: "nope" })).status, 400);
  assert.equal((await send(setup.url, "/v1/feedback/forget", { version: 1, install: feedback(1).install, extra: 1 })).status, 400);
});

test("what is older than the retention goes, except what the team marked keep", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  let now = Date.now();
  const relay = createReportRelay({ keysDir: base.keys, dataDir: base.data, now: () => now, pruneAtStart: false, github: null });
  t.after(() => relay.close());
  const intake = relay.feedback!;
  for (const n of [1, 2, 3]) assert.equal(intake.receive(JSON.stringify(feedback(n))).result, "received");
  assert.ok(intake.update(2, JSON.stringify({ status: "keep" })).ok);
  now += 89 * 86_400_000;
  assert.equal(intake.prune(), 0, "inside the retention nothing goes");
  intake.receive(JSON.stringify(feedback(4, { createdAt: new Date(now).toISOString() })));
  now += 2 * 86_400_000;
  assert.equal(intake.prune(), 2, "the two unmarked old ones go");
  assert.deepEqual(intake.list(new URLSearchParams())!.items.map((item) => item.ref), [4, 2]);
});

test("the inbox page is served with a CSP that allows only its own script and style", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  const response = await fetch(`${setup.url}/inbox`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const csp = response.headers.get("content-security-policy") ?? "";
  for (const part of ["default-src 'none'", "connect-src 'self'", "img-src blob:", "frame-ancestors 'none'"]) assert.ok(csp.includes(part), part);
  const html = await response.text();
  const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
  const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? "";
  assert.ok(csp.includes(`script-src ${hash(script)}`), "script hash matches");
  assert.ok(csp.includes(`style-src ${hash(style)}`), "style hash matches");
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "untrusted text never becomes markup");
  assert.equal((await fetch(`${setup.url}/inbox`, { method: "POST" })).status, 404);
});
