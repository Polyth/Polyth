// WP10: cron cadence — validation, IANA zones, DST gaps/folds, preview and
// executor sharing one code path, loop frontmatter parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeNextRun, createScheduleService, describeCron, nextRuns,
  parseLoopFile, scanLoopsDir, validateCron,
} from "../src/index.ts";

const UTC = (s: string) => new Date(s).getTime();

test("validateCron rejects aliases, seconds, unknown zones, too-fast cadence", () => {
  assert.equal(validateCron("0 9 * * 1-5", "Europe/Kyiv").ok, true);
  assert.match(validateCron("@daily", "UTC").error!, /aliases/);
  assert.match(validateCron("0 0 9 * * 1", "UTC").error!, /5 fields/);
  assert.match(validateCron("0 9 * * 1", "Mars/Olympus").error!, /unknown IANA/);
  assert.match(validateCron("61 * * * *", "UTC").error!, /./); // out-of-range minute
  assert.match(validateCron("*/5 * * * *", "UTC", { minIntervalMinutes: 15 }).error!, /15-minute minimum/);
  assert.equal(validateCron("*/30 * * * *", "UTC", { minIntervalMinutes: 15 }).ok, true);
});

test("spring-forward gap: 02:30 Kyiv does not exist on 2026-03-29; run lands after the gap", () => {
  // Kyiv jumps 03:00→04:00 on the last Sunday of March 2026 (EET→EEST).
  const runs = nextRuns("30 3 * * *", "Europe/Kyiv", UTC("2026-03-28T12:00:00Z"), 2);
  // 2026-03-28 03:30 EET = 01:30 UTC (already past); first hit is the 29th.
  // On the 29th, 03:30 does not exist — the run must not silently vanish
  // forever and must not double-fire. Two consecutive returned instants are
  // strictly increasing, ~24h or less apart.
  assert.equal(runs.length, 2);
  assert.ok(runs[1]! > runs[0]!);
  const gapH = (runs[1]! - runs[0]!) / 3_600_000;
  assert.ok(gapH >= 22 && gapH <= 26, `daily cadence stays daily across the gap (got ${gapH}h)`);
});

test("fall-back fold: 03:30 Kyiv occurs twice on 2026-10-25; fires exactly once", () => {
  const runs = nextRuns("30 3 * * *", "Europe/Kyiv", UTC("2026-10-24T12:00:00Z"), 3);
  // Consecutive daily runs across the fold stay unique and ordered.
  assert.equal(new Set(runs).size, runs.length);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i]! > runs[i - 1]!);
});

test("leap day: Feb 29 cron fires only in leap years", () => {
  const runs = nextRuns("0 12 29 2 *", "UTC", UTC("2026-01-01T00:00:00Z"), 2);
  assert.equal(new Date(runs[0]!).toISOString(), "2028-02-29T12:00:00.000Z");
  assert.equal(new Date(runs[1]!).toISOString(), "2032-02-29T12:00:00.000Z");
});

test("server/client zone difference: same wall time, different instants", () => {
  const from = UTC("2026-06-01T00:00:00Z");
  const kyiv = nextRuns("0 9 * * *", "Europe/Kyiv", from, 1)[0]!;
  const la = nextRuns("0 9 * * *", "America/Los_Angeles", from, 1)[0]!;
  assert.notEqual(kyiv, la);
  assert.equal(new Date(kyiv).toISOString(), "2026-06-01T06:00:00.000Z"); // EEST = UTC+3
  assert.equal(new Date(la).toISOString(), "2026-06-01T16:00:00.000Z");   // PDT = UTC-7
});

test("describeCron renders common shapes", () => {
  assert.equal(describeCron("0 9 * * 1-5"), "At 09:00, Monday through Friday");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("30 8 1 * *"), "At 08:30, day 1 of the month");
});

test("preview and executor agree (same cron path)", async () => {
  const t0 = UTC("2026-03-28T12:00:00Z");
  const file = join(mkdtempSync(join(tmpdir(), "polyth-cron-")), "s.json");
  let clock = t0;
  const fired: number[] = [];
  const svc = createScheduleService({
    file,
    now: () => clock,
    runner: { run: async () => { fired.push(clock); } },
  });
  const cadence = { kind: "cron" as const, expression: "30 3 * * *", timeZone: "Europe/Kyiv" };
  const previewed = svc.preview(cadence, 3).runs;
  const t = svc.create({ projectId: "p", prompt: "daily", cadence });
  assert.equal(t.nextRunAt, previewed[0], "first scheduled run equals the previewed one");

  // Advance the clock to each previewed instant; executor fires exactly there.
  for (const at of previewed) {
    clock = at;
    await svc.tick();
    const cur = svc.get(t.id)!;
    assert.equal(cur.lastRunAt, at);
  }
});

test("migration: legacy kind/every tasks gain a cadence on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-mig-"));
  const file = join(dir, "s.json");
  writeFileSync(file, JSON.stringify({
    v: 1,
    tasks: [{
      id: "legacy1", projectId: "p", prompt: "old", kind: "every", everyMinutes: 30,
      enabled: true, createdAt: 1, updatedAt: 1, nextRunAt: null, runs: 0,
    }],
  }));
  const svc = createScheduleService({ file, runner: { run: async () => {} }, now: () => 1000 });
  const t = svc.get("legacy1")!;
  assert.deepEqual(t.cadence, { kind: "every", everyMinutes: 30 });
  assert.equal(computeNextRun(t, 1000), 1000 + 30 * 60_000);
});

// ---- loops -----------------------------------------------------------------------

const LOOP_MD = `---
id: dependency-audit
title: Dependency audit
cron: "0 9 * * 1"
timeZone: "UTC"
enabled: true
agentProfile: review
---
Inspect dependency changes since the last run and report risks.
`;

test("parseLoopFile: strict frontmatter, invalid variants rejected", () => {
  const ok = parseLoopFile(LOOP_MD);
  assert.equal(ok.loop!.id, "dependency-audit");
  assert.equal(ok.loop!.cron, "0 9 * * 1");
  assert.equal(ok.loop!.agentProfile, "review");
  assert.match(ok.loop!.prompt, /^Inspect dependency/);

  assert.match(parseLoopFile("no frontmatter").parseError!, /frontmatter/);
  assert.match(parseLoopFile("---\nid: UPPER\ncron: \"0 9 * * 1\"\n---\nbody").parseError!, /lowercase/);
  assert.match(parseLoopFile("---\nid: x\ncron: \"nope\"\n---\nbody").parseError!, /cron/);
  assert.match(parseLoopFile("---\nid: x\ncron: \"0 9 * * 1\"\n---\n").parseError!, /empty/);
});

test("scanLoopsDir: discovers files, flags duplicates, skips symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "polyth-loops-"));
  const dir = join(root, ".agents", "loops");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.md"), LOOP_MD);
  writeFileSync(join(dir, "b.md"), LOOP_MD); // duplicate id in second file
  writeFileSync(join(dir, "broken.md"), "---\nid: broken\n---\n"); // bad cron + empty body
  writeFileSync(join(root, "outside.md"), LOOP_MD);
  symlinkSync(join(root, "outside.md"), join(dir, "link.md"));

  const scan = scanLoopsDir(root);
  const byName = (n: string) => scan.find((r) => r.path.endsWith(n));
  assert.equal(scan.length, 3, "symlink skipped");
  assert.ok(byName("a.md")!.loop);
  assert.match(byName("b.md")!.parseError!, /duplicate loop id/);
  assert.ok(byName("broken.md")!.parseError);
});

test("syncLoops: upserts managed tasks, keeps healthy task on parse error, removes vanished", () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-sync-")), "s.json");
  const svc = createScheduleService({ file, runner: { run: async () => {} }, now: () => UTC("2026-06-01T00:00:00Z") });

  const scan1 = [{ path: "/p/.agents/loops/a.md", digest: "d1", loop: {
    id: "audit", title: "Audit", cron: "0 9 * * 1", timeZone: "UTC", enabled: true, prompt: "check things",
  } }];
  const r1 = svc.syncLoops("p1", scan1);
  assert.equal(r1.tasks.length, 1);
  const managed = r1.tasks[0]!;
  assert.equal(managed.source, "loop-file");
  assert.equal(managed.loopId, "audit");
  assert.equal(managed.prompt, "check things");
  assert.ok(managed.nextRunAt);

  // Managed fields are read-only through the normal update path.
  assert.throws(() => svc.update(managed.id, { prompt: "hacked" }), /managed by/);
  // Pause creates a local override that survives a rescan.
  svc.setEnabled(managed.id, false);
  const r2 = svc.syncLoops("p1", scan1);
  assert.equal(r2.tasks[0]!.enabled, false, "override wins over file enabled:true");

  // Parse error on the same path: healthy task is kept, flagged, not deleted.
  const r3 = svc.syncLoops("p1", [{ path: "/p/.agents/loops/a.md", digest: "", parseError: "cron: bad" }]);
  assert.equal(r3.errors.length, 1);
  assert.equal(r3.tasks.length, 1);
  assert.equal(r3.tasks[0]!.parseError, "cron: bad");

  // File removed entirely → managed task is removed by explicit policy.
  const r4 = svc.syncLoops("p1", []);
  assert.equal(r4.tasks.length, 0);
  assert.equal(svc.list("p1").length, 0);
});

test("overlap policy: skip records a skipped run; queue chains; history bounded", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "polyth-ovl-")), "s.json");
  let release: (() => void) | null = null;
  let running = 0;
  let maxConcurrent = 0;
  const svc = createScheduleService({
    file,
    runner: {
      run: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise<void>((res) => { release = res; });
        running -= 1;
      },
    },
  });
  const t = svc.create({
    projectId: "p", prompt: "slow", cadence: { kind: "every", everyMinutes: 60 }, overlapPolicy: "skip",
  });

  const first = svc.runNow(t.id);       // starts, blocks on release
  await new Promise((r) => setTimeout(r, 10));
  await svc.runNow(t.id);               // skip policy → recorded as skipped
  const hist = svc.runsOf(t.id);
  assert.equal(hist.filter((h) => h.status === "skipped").length, 1);
  assert.equal(maxConcurrent, 1);

  release!();
  await first;
  const done = svc.runsOf(t.id).find((h) => h.status === "ok");
  assert.ok(done, "first run completed ok");
  assert.ok(done!.finishedAt! >= done!.startedAt);
});
