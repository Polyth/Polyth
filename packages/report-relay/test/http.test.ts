import assert from "node:assert/strict";
import test from "node:test";

import { BUG_REPORT_LIMITS } from "@polyth/contracts/bug-report";

import { acceptedVersion } from "../src/index.ts";
import { PASSWORD, REPO, report, screenshot, serve, uuid } from "./support.ts";

const ISSUE_MARKER = /<!-- polyth-report fp=[0-9a-f]{16} id=[0-9a-f-]{36} group=default key=default -->/;

test("the exact wire shape is required and a created report files issue plus attachments", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());

  assert.equal((await fetch(`${setup.url}/v1/report`, { method: "POST", body: "{}" })).status, 400, "content type");
  assert.equal((await setup.post("{")).status, 400, "unparseable JSON");
  for (const body of [
    { ...report(), extra: true },
    { ...report(), text: "x".repeat(BUG_REPORT_LIMITS.textChars + 1) },
    { ...report(), version: 2 },
  ]) {
    const response = await setup.post(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 120));
    assert.deepEqual(await response.json(), { result: "invalid" });
  }
  assert.equal(setup.github.issues.length, 0);

  const response = await setup.post(report());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "created", issue: 100 });

  const issue = setup.github.issue(100);
  assert.ok(issue);
  assert.equal(issue.title, "[1.2.3-nightly] It froze when I opened a session · darwin arm64");
  assert.deepEqual(issue.labels, ["nightly-report", "v1.2.3-nightly", "platform:darwin", "group:default"]);
  assert.match(issue.body, ISSUE_MARKER);
  assert.match(issue.body, /Release: https:\/\/github\.com\/Polyth\/Polyth\/releases\/tag\/v1\.2\.3-nightly/);
  assert.match(issue.body, new RegExp(`Report data: \\[report\\.json\\]\\(https://github\\.com/${REPO}/blob/attachments/`));
  assert.match(issue.body, /> It froze when I opened a session/);

  const path = `reports/${new Date(report().createdAt).toISOString().slice(0, 10)}/aaaabbbb-1111-4222-8333-444444444444`;
  const data = setup.github.content(`${path}/report.json`);
  assert.ok(data);
  const stored = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal(stored.reportId, "aaaabbbb-1111-4222-8333-444444444444");
  assert.equal(stored.screenshot, null);
  assert.equal(setup.github.content(`${path}/screenshot.jpg`), undefined, "no screenshot was sent");
  assert.ok(setup.fixture);
});

test("a screenshot is uploaded once and embedded, and text cannot ping or cross-link", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  const body = report({ text: "ping @octocat about #123\nsecond line", screenshot: screenshot() });
  assert.equal((await setup.post(body)).status, 200);

  const issue = setup.github.issue(100);
  assert.ok(issue);
  assert.ok(issue.labels.includes("has-screenshot"));
  assert.match(issue.body, /!\[screenshot\]\(https:\/\/github\.com\/Polyth\/private-nightly-reports\/blob\/attachments\/reports\/\d{4}-\d{2}-\d{2}\/aaaabbbb-1111-4222-8333-444444444444\/screenshot\.jpg\?raw=true\)/);
  assert.ok(issue.body.includes("@\u200doctocat"), "the mention is neutralized");
  assert.ok(issue.body.includes("#\u200d123"), "the issue reference is neutralized");
  assert.ok(!issue.body.includes("@octocat"));
  assert.ok(!issue.body.includes("#123\n"));
  assert.ok(issue.title.includes("@\u200doctocat"), "the title is neutralized too");
  assert.equal(setup.github.uploads.length, 2);
});

test("a body over the cap is refused before parsing", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  const oversized = JSON.stringify({ text: "x".repeat(BUG_REPORT_LIMITS.bodyBytes) });
  const response = await setup.post(oversized);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { result: "invalid" });
  assert.equal(setup.github.issues.length, 0);
});

test("the password is required, and repeated failures lock the source out", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());

  assert.equal((await setup.post(report(), { authorization: "" })).status, 401);
  const wrong = await setup.post(report({ reportId: uuid(1) }), { authorization: "Bearer not-the-password" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { result: "password" });
  assert.equal((await setup.post(report())).status, 200, "the right password still works");
  assert.equal(setup.github.issues.length, 1);

  // A fresh relay so the successful report above did not consume the source.
  const locked = await serve();
  t.after(() => locked.close());
  for (let attempt = 0; attempt < 11; attempt++) {
    assert.equal((await locked.post(report(), { authorization: "Bearer wrong" })).status, 401, `attempt ${attempt}`);
  }
  const blocked = await locked.post(report());
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { result: "rate" });
});

test("only published nightly versions are accepted", async (t) => {
  const setup = await serve({ allowVersion: (version) => version === "9.9.9-nightly" });
  t.after(() => setup.close());
  const response = await setup.post(report());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { result: "version" });
  assert.equal((await setup.post(report({ app: { ...report().app, version: "9.9.9-nightly", channel: "nightly" } }))).status, 200);

  const releases = [
    { tag_name: "v1.2.3-nightly", draft: false },
    { tag_name: "v4.0.0-nightly", draft: true },
    { tag_name: "v1.0.0", draft: false },
    { tag_name: "v3.0.0-nightly", draft: false },
  ];
  const listed = await serve({
    allowVersion: undefined,
    fetchFn: async () => new Response(JSON.stringify(releases), { status: 200 }),
  });
  t.after(() => listed.close());
  assert.equal((await listed.post(report())).status, 200);
  assert.equal((await listed.post(report({ reportId: uuid(2), app: { ...report().app, version: "1.0.0", channel: "stable" } }))).status, 422);
  assert.equal((await listed.post(report({ reportId: uuid(3), app: { ...report().app, version: "4.0.0-nightly" } }))).status, 422, "drafts are not published");
  assert.equal((await listed.post(report({ reportId: uuid(4), app: { ...report().app, version: "3.0.1-nightly" } }))).status, 422, "newer than every published nightly");
  assert.equal((await listed.post(report({ reportId: uuid(5), app: { ...report().app, version: "1.2.1-nightly" } }))).status, 200, "an older nightly the list no longer shows");
});

test("version acceptance: published, or older than the newest published nightly", () => {
  const published = new Set(["1.2.357-nightly", "1.2.359-nightly"]);
  assert.equal(acceptedVersion("1.2.359-nightly", published), true);
  assert.equal(acceptedVersion("1.2.300-nightly", published), true);
  assert.equal(acceptedVersion("1.1.999-nightly", published), true);
  assert.equal(acceptedVersion("1.2.360-nightly", published), false);
  assert.equal(acceptedVersion("1.10.0-nightly", published), false, "numeric, not lexical");
  assert.equal(acceptedVersion("1.2.300", published), false);
  assert.equal(acceptedVersion("1.2.300-nightly", new Set()), false);
});

test("a release list that was never fetched answers unavailable instead of accepting", async (t) => {
  const setup = await serve({
    allowVersion: undefined,
    fetchFn: async () => { throw new Error("offline"); },
  });
  t.after(() => setup.close());
  const response = await setup.post(report());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { result: "unavailable" });
  assert.equal(setup.github.issues.length, 0);
});

test("one source and one install send without a cap; only the global issue budget answers rate", async (t) => {
  const open = await serve();
  t.after(() => open.close());
  for (let index = 1; index <= 40; index++) {
    const response = await open.post(report({ reportId: uuid(index), text: `Report number ${index}` }));
    assert.equal(response.status, 200, `report ${index} from one source and one install`);
  }
  assert.equal(open.github.issues.length + open.github.comments.length, 40);

  const global = await serve({ limits: { globalDay: 1 } });
  t.after(() => global.close());
  assert.equal((await global.post(report())).status, 200);
  const over = await global.post(report({ reportId: uuid(3), install: "b".repeat(32) }));
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { result: "rate" });
});

test("health names only whether GitHub is configured, and unknown routes are 404", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  assert.deepEqual(await (await setup.get("/v1/health")).json(), { ok: true, github: true });
  const unconfigured = await serve({ github: null });
  t.after(() => unconfigured.close());
  assert.deepEqual(await (await unconfigured.get("/v1/health")).json(), { ok: true, github: false });
  assert.equal((await unconfigured.post(report())).status, 503);
  const missing = await setup.get("/v1/nowhere");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not-found" });
  assert.equal((await fetch(`${setup.url}/v1/report`)).status, 404);
});

test("the kill switch answers unavailable to every report", async (t) => {
  const setup = await serve({ off: true });
  t.after(() => setup.close());
  const response = await setup.post(report());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { result: "unavailable" });
  assert.equal(setup.github.issues.length, 0);
});

test("the request log carries no password, text, address or install id", async (t) => {
  const setup = await serve();
  t.after(() => setup.close());
  assert.equal((await setup.post(report())).status, 200);
  assert.equal((await setup.get("/v1/health")).status, 200);

  const text = JSON.stringify(setup.logs);
  for (const secret of [PASSWORD, "It froze when I opened a session", "127.0.0.1", "a".repeat(32)]) {
    assert.ok(!text.includes(secret), `log leaks ${secret}`);
  }
  const reportLine = setup.logs.find((event) => "route" in event && event.route === "report");
  assert.ok(reportLine && "result" in reportLine);
  assert.deepEqual(Object.keys(reportLine).sort(), ["latencyMs", "result", "route", "status"]);
  assert.equal(reportLine.result, "created");
  assert.equal(reportLine.status, 200);
  assert.equal(new Set(setup.logs.map((event) => ("route" in event ? event.route : `github:${event.github}`))).size, 2);
});
