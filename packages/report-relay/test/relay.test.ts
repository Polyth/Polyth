import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createReportRelay, type ReportRelayOptions } from "../src/index.ts";
import type { RelayGitHub } from "../src/types.ts";
import { FakeGitHub, PASSWORD, fixture, report, screenshot, uuid, type Fixture } from "./support.ts";

const DAY = 86_400_000;
const SOURCE = "198.51.100.9";
const TOKEN = `Bearer ${PASSWORD}`;

function relayFor(base: Fixture, github: RelayGitHub, options: ReportRelayOptions = {}) {
  return createReportRelay({
    keysDir: base.keys,
    dataDir: base.data,
    github,
    allowVersion: () => true,
    pruneAtStart: false,
    ...options,
  });
}

const send = (relay: ReturnType<typeof relayFor>, body: unknown) => relay.report(JSON.stringify(body), SOURCE, TOKEN);

test("a repeated reportId returns the stored issue without touching GitHub", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github);
  const body = report();

  assert.deepEqual(await send(relay, body), { result: "created", issue: 100 });
  const uploads = github.uploads.length;
  const calls = github.calls;
  assert.deepEqual(await send(relay, body), { result: "created", issue: 100 });
  assert.equal(github.uploads.length, uploads);
  assert.equal(github.calls, calls);
  assert.equal(github.issues.length, 1);
  relay.close();
});

test("the same error fingerprint under an open issue becomes a comment", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github);
  const errors = [{ time: new Date().toISOString(), text: "Error: window froze\nCode: E_FREEZE\nComponent: chat" }];

  assert.deepEqual(await send(relay, report({ errors })), { result: "created", issue: 100 });
  assert.deepEqual(await send(relay, report({ reportId: uuid(2), errors })), { result: "added", issue: 100 });
  assert.equal(github.issues.length, 1);
  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0]!.issue, 100);
  assert.match(github.comments[0]!.body, /<!-- polyth-report fp=[0-9a-f]{16} id=[0-9a-f-]{36} -->/);
  assert.match(github.comments[0]!.body, /E_FREEZE|Settings and packages/);
  assert.equal(github.uploads.length, 2, "one report.json per report, no screenshot");
  relay.close();
});

test("a closed issue is not commented on; a new issue names the previous one", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github);
  const errors = [{ time: new Date().toISOString(), text: "Error: window froze\nHTTP status: 500" }];

  assert.deepEqual(await send(relay, report({ errors })), { result: "created", issue: 100 });
  github.states.set(100, "closed");
  assert.deepEqual(await send(relay, report({ reportId: uuid(2), errors })), { result: "created", issue: 101 });
  assert.equal(github.comments.length, 0);
  assert.match(github.issue(101)!.body, /Previous report issue: 100\./);
  relay.close();
});

test("without errors only the same install re-sending the same words dedups", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github, { limits: { perSourceMinute: 100, perInstallDay: 100 } });
  const install = "c".repeat(32);

  assert.deepEqual(await send(relay, report({ install, text: "The window froze" })), { result: "created", issue: 100 });
  assert.deepEqual(
    await send(relay, report({ reportId: uuid(2), install, text: "  the   window\nFROZE " })),
    { result: "added", issue: 100 },
  );
  assert.deepEqual(
    await send(relay, report({ reportId: uuid(3), install: "d".repeat(32), text: "The window froze" })),
    { result: "created", issue: 101 },
  );
  relay.close();
});

test("state is a JSON file with the report and fingerprint maps", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github);
  await send(relay, report({ screenshot: screenshot() }));
  relay.close();

  const file = join(base.data, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as {
    reports: Record<string, { issue: number; result: string; at: number }>;
    fingerprints: Record<string, { issue: number; at: number }>;
  };
  assert.equal(state.reports["aaaabbbb-1111-4222-8333-444444444444"]!.issue, 100);
  assert.equal(state.reports["aaaabbbb-1111-4222-8333-444444444444"]!.result, "created");
  assert.equal(Object.values(state.fingerprints)[0]!.issue, 100);
  assert.deepEqual(readdirSync(base.data), ["state.json"], "the temporary file was renamed into place");
});

test("a corrupt state file is set aside and the relay starts empty", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  writeFileSync(join(base.data, "state.json"), "{ this is not json");
  const github = new FakeGitHub();
  const relay = relayFor(base, github);

  assert.deepEqual(await send(relay, report()), { result: "created", issue: 100 });
  relay.close();
  const aside = readdirSync(base.data).filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.ok(JSON.parse(readFileSync(join(base.data, "state.json"), "utf8")));
});

test("state entries expire after 30 days, so a stale id files again", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const start = Date.parse("2026-01-05T10:00:00Z");
  const first = new FakeGitHub();
  const relay = relayFor(base, first, { now: () => start });
  const body = report({ createdAt: new Date(start).toISOString() });
  assert.deepEqual(await send(relay, body), { result: "created", issue: 100 });
  relay.close();

  const later = start + 31 * DAY;
  const second = new FakeGitHub();
  const reopened = relayFor(base, second, { now: () => later });
  assert.deepEqual(
    await send(reopened, report({ createdAt: new Date(later).toISOString() })),
    { result: "created", issue: 100 },
  );
  assert.equal(second.issues.length, 1, "the expired id is a new report, not an idempotent hit");
  reopened.close();
});

test("a failed GitHub filing answers unavailable and records nothing", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github);
  github.failures = 1;
  assert.deepEqual(await send(relay, report()), { result: "unavailable" });
  assert.equal(github.issues.length, 0, "nothing half-filed was recorded");
  assert.deepEqual(await send(relay, report()), { result: "created", issue: 100 });
  relay.close();
});

test("prune forwards the retention window to GitHub and never throws", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = relayFor(base, github, { retentionDays: 30 });
  const result = await relay.prune();
  assert.deepEqual(result, { closed: 0 });
  assert.equal(github.pruned.length, 1);
  assert.equal(github.pruned[0]!.keepDays, 30);
  relay.close();

  const broken = new FakeGitHub();
  broken.prune = async () => { throw new Error("github down"); };
  const failing = relayFor(base, broken);
  assert.deepEqual(await failing.prune(), { closed: 0 });
  failing.close();
});
