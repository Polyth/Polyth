import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createReportRelay } from "../src/index.ts";
import { ReportStats, dayKey, renderMarkdown, type RecordInput } from "../src/stats.ts";
import { mint } from "../src/tokens.ts";
import { FakeGitHub, fixture, report, uuid } from "./support.ts";

const AT = Date.parse("2026-11-24T10:00:00Z");
const DAY = 86_400_000;
const SOURCE = "198.51.100.9";

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "polyth-report-stats-"));
  return { dir, file: join(dir, "stats.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One filed report, with everything a test does not care about defaulted. */
const entry = (overrides: Partial<RecordInput> = {}): RecordInput => ({
  at: AT,
  group: "qa-eu",
  install: "a".repeat(32),
  fingerprint: "0123456789abcdef",
  issue: 100,
  result: "created",
  screenshot: false,
  lowSignal: false,
  platform: "darwin",
  version: "1.2.3-nightly",
  ...overrides,
});

test("counters separate groups, days and denominators", (t) => {
  const base = scratch();
  t.after(base.cleanup);
  const stats = new ReportStats(base.file, () => AT);

  stats.record(entry());
  stats.record(entry({ install: "b".repeat(32) }));
  stats.record(entry({ group: "beta", install: "c".repeat(32) }));
  stats.record(entry({ group: "beta", install: "c".repeat(32), result: "added", fingerprint: "fedcba9876543210", issue: 101 }));
  stats.record(entry({ at: AT + DAY, install: "d".repeat(32) }));

  const rendered = stats.render(AT + DAY, 7);
  assert.equal(rendered.date, "2026-11-25");
  assert.equal(rendered.empty, false);
  assert.match(rendered.markdown, /\| qa-eu \| 3 \| 3 \| 0 \| 3 \| 1\.00 \|/, "aggregate row");
  assert.match(rendered.markdown, /\| beta \| 2 \| 1 \| 1 \| 1 \| 2\.00 \|/, "one install-day, two reports");
  assert.match(rendered.markdown, /\| 2026-11-24 \| qa-eu \| 2 \| 2 \| 0 \| 2 \| 1\.00 \|/, "per-day row");
  assert.match(rendered.markdown, /\| 2026-11-25 \| qa-eu \| 1 \| 1 \| 0 \| 1 \|/, "per-day row");
  // The same fingerprint from two groups is the signal this file exists for.
  assert.match(rendered.markdown, /## Seen in more than one group/);
  assert.match(rendered.markdown, /\| #100 \| `0123456789abcdef` \| beta, qa-eu \| 4 \|/);
  assert.ok(!rendered.markdown.includes("a".repeat(32)), "no install id is published");
});

test("the window is bounded and an empty window publishes nothing", (t) => {
  const base = scratch();
  t.after(base.cleanup);
  const stats = new ReportStats(base.file, () => AT);
  assert.equal(stats.render(AT).empty, true);
  assert.match(stats.render(AT).markdown, /No reports in the window/);

  stats.record(entry());
  assert.equal(stats.render(AT + 30 * DAY).empty, true, "30 days later the window is empty again");
  assert.match(stats.render(AT, 3).markdown, /last 3 days/);
  assert.match(stats.render(AT, 365).markdown, /last 14 days/, "clamped to what is kept");
});

test("uploading is skipped until the content changes, and the marker survives a reload", (t) => {
  const base = scratch();
  t.after(base.cleanup);
  const stats = new ReportStats(base.file, () => AT);
  stats.record(entry());

  const first = stats.render(AT);
  assert.equal(stats.needsUpload(first), true);
  stats.markUploaded(first);
  assert.equal(stats.needsUpload(stats.render(AT)), false, "the same content is not uploaded twice");

  stats.record(entry({ fingerprint: "fedcba9876543210", issue: 101 }));
  const changed = stats.render(AT);
  assert.equal(stats.needsUpload(changed), true);
  stats.markUploaded(changed);
  assert.equal(stats.needsUpload(stats.render(AT)), false);

  const reloaded = new ReportStats(base.file, () => AT);
  assert.equal(reloaded.needsUpload(reloaded.render(AT)), false, "the marker is durable");
});

test("days older than the kept window are dropped and a corrupt file is set aside", (t) => {
  const base = scratch();
  t.after(base.cleanup);
  const stats = new ReportStats(base.file, () => AT);
  stats.record(entry());
  const later = AT + 20 * DAY;
  stats.record(entry({ at: later }));
  stats.prune(later);

  const reloaded = new ReportStats(base.file, () => later);
  const markdown = reloaded.render(later, 14).markdown;
  assert.ok(!markdown.includes(dayKey(AT)), "the old day is gone");
  assert.ok(markdown.includes(dayKey(later)));

  writeFileSync(base.file, "{ not json");
  const aside = new ReportStats(base.file, () => later);
  assert.equal(aside.render(later).empty, true);
  assert.equal(readdirSync(base.dir).filter((name) => name.startsWith("stats.json.corrupt-")).length, 1);
});

test("a markdown file is published once per day on the attachments branch", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const relay = createReportRelay({
    keysDir: base.keys,
    dataDir: base.data,
    github,
    allowVersion: () => true,
    pruneAtStart: false,
    now: () => AT,
  });
  const token = mint("qa-eu");
  writeFileSync(join(base.keys, "tokens.json"), JSON.stringify({
    tokens: [{ keyId: "qa-eu", group: "qa-eu", label: "QA EU", hash: token.hash, dayCap: 40 }],
  }));

  await relay.prune();
  assert.deepEqual(github.uploads.filter((upload) => upload.path.startsWith("stats/")), [], "no activity, no artifact");

  await relay.report(
    JSON.stringify(report({ createdAt: new Date(AT).toISOString() })),
    SOURCE,
    `Bearer ${token.secret}`,
  );
  await relay.prune();
  const published = github.uploads.filter((upload) => upload.path.startsWith("stats/"));
  assert.equal(published.length, 1);
  assert.equal(published[0]!.path, "stats/2026-11-24.md");
  const markdown = Buffer.from(published[0]!.content, "base64").toString("utf8");
  assert.match(markdown, /^# Nightly report activity · 2026-11-24/);
  assert.match(markdown, /\| qa-eu \| 1 \| 1 \| 0 \| 1 \| 1\.00 \|/);
  assert.ok(!markdown.includes("It froze when I opened a session"), "never the report text");

  await relay.prune();
  assert.equal(github.uploads.filter((upload) => upload.path.startsWith("stats/")).length, 1, "idempotent within the day");

  // A second group on the next day adds a file for that day.
  await relay.report(
    JSON.stringify(report({ reportId: uuid(2), install: "e".repeat(32), text: "Sidebar vanished" })),
    SOURCE,
    `Bearer ${token.secret}`,
  );
  relay.close();

  const tomorrow = AT + DAY;
  const next = createReportRelay({
    keysDir: base.keys,
    dataDir: base.data,
    github,
    allowVersion: () => true,
    pruneAtStart: false,
    now: () => tomorrow,
  });
  await next.prune();
  const days = github.uploads.filter((upload) => upload.path.startsWith("stats/")).map((upload) => upload.path);
  assert.deepEqual(days, ["stats/2026-11-24.md", "stats/2026-11-25.md"]);
  next.close();
});

test("statsUpload:false and no GitHub target publish nothing", async (t) => {
  const base = fixture();
  t.after(base.cleanup);
  const github = new FakeGitHub();
  const quiet = createReportRelay({
    keysDir: base.keys,
    dataDir: base.data,
    github,
    allowVersion: () => true,
    pruneAtStart: false,
    statsUpload: false,
    now: () => AT,
  });
  await quiet.report(JSON.stringify(report()), SOURCE, "Bearer tester-password-123");
  await quiet.prune();
  assert.equal(github.uploads.filter((upload) => upload.path.startsWith("stats/")).length, 0);
  quiet.close();

  const unconfigured = createReportRelay({
    keysDir: base.keys, dataDir: base.data, github: null, allowVersion: () => true, pruneAtStart: false, now: () => AT,
  });
  assert.deepEqual(await unconfigured.prune(), { closed: 0 });
  unconfigured.close();
});

test("renderMarkdown is stable for the same input", () => {
  const day = { date: "2026-11-24", stats: { groups: {}, fingerprints: {} } };
  assert.equal(renderMarkdown("2026-11-24", [day], 7), renderMarkdown("2026-11-24", [day], 7));
  assert.ok(renderMarkdown("2026-11-24", [day], 7).includes("No reports in the window"));
});
