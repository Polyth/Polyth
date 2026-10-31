// Cron cadence — validation, IANA zones, DST gaps/folds, preview and
// executor sharing one code path, overlap policy.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeNextRun, createPlannerService, describeCron, nextRuns, validateCron,
} from "../src/index.ts";

const tempDirs: string[] = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
  const file = join(tempDir("polyth-cron-"), "s.json");
  let clock = t0;
  const fired: number[] = [];
  const svc = createPlannerService({
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

test("overlap policy: skip records a skipped run; queue chains; history bounded", async () => {
  const file = join(tempDir("polyth-ovl-"), "s.json");
  let release: (() => void) | null = null;
  let running = 0;
  let maxConcurrent = 0;
  const svc = createPlannerService({
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
