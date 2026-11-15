import test from "node:test";
import assert from "node:assert/strict";
import type { HistoryPoint, MonitoringHost, MonitoringPolicy, MonitoringSnapshot } from "../src/contracts.ts";
import { machinesOf, vitalsOf, type Machine } from "../widgets/model.ts";
import {
  chartsAreWide, DEFAULT_WIDGET_CONFIG, diskForecastOf, fleetOf, gaugeCountOf, historyColumnOf, historyValues,
  isQuiet, machineOf, rhythmOf, scaleOf, vitalKey, widgetConfigOf, widgetSizeOf, widgetToneOf, widgetVitalsOf,
  type MonitoringWidgetConfig,
} from "../widgets/widgetModel.ts";

const GiB = 1024 ** 3;
const DAY_MS = 86_400_000;
const STEP_MS = 5 * 60_000;

const host = (projectId: string, machineId: string, kind: MonitoringHost["kind"] = "local", supported = true): MonitoringHost =>
  ({ projectId, name: projectId, kind, machineId, supported, fileTailsAvailable: true, hostLogsAvailable: true, canEditPolicy: true, processesAvailable: true });
const policy: MonitoringPolicy = { revision: 1, agentAccess: { metrics: true, services: true, logs: true, processes: false }, serviceUnits: [], logPaths: [], memoryWarningPercent: 85, loadWarningRatio: 1, diskWarningPercent: 90 };
const snapshot = (warnings: MonitoringSnapshot["warnings"]): MonitoringSnapshot => ({
  host: host("p", "local"), sampledAt: 1_700_000_000_000, warnings, services: [], servicesAvailable: true,
  metrics: { hostname: "watcher", platform: "linux", cpuCount: 4, load: [6.11, 7.82, 7.24], memoryTotal: 23.4 * GiB, memoryAvailable: 13.7 * GiB, uptimeSeconds: 1,
    disks: [{ mount: "/", size: 45 * GiB, used: 41 * GiB, available: 4.3 * GiB }, { mount: "/data", size: 150 * GiB, used: 123 * GiB, available: 20 * GiB }] },
});
const machine = (id: string, name: string): Machine => ({ id, projectId: id, kind: "local", name });
const near = (actual: number | undefined, expected: number, tolerance: number): void =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);

/** One reading every 5 minutes; `startDisk` at `spanMs` before `now`, growing `perDay`. */
const diskSeries = (now: number, startDisk: number, perDay: number, spanMs = DAY_MS): HistoryPoint[] =>
  Array.from({ length: Math.round(spanMs / STEP_MS) + 1 }, (_, index) => {
    const at = now - spanMs + index * STEP_MS;
    return [at, null, null, startDisk + (at - (now - spanMs)) / DAY_MS * perDay] as HistoryPoint;
  });

/** Local wall-clock time, so the rhythm tests hold in every time zone. */
const local = (year: number, month: number, day: number, hour = 0, minute = 0): number => new Date(year, month, day, hour, minute).getTime();
const loadPoint = (at: number, load: number): HistoryPoint => [at, load, null, null];

test("a stored widget config is made whole again", () => {
  for (const raw of [undefined, null, [], "nonsense", 42, [1, 2]]) assert.deepEqual(widgetConfigOf(raw), DEFAULT_WIDGET_CONFIG);
  const valid: MonitoringWidgetConfig = { look: "charts", machine: "ssh-1", metrics: ["load", "disk:/data"], range: "7d", forecast: false, quiet: true, rhythmMetric: "memory" };
  assert.deepEqual(widgetConfigOf(valid), valid);
  const odd = widgetConfigOf({ look: "sparkly", range: "3h", machine: "   ", metrics: "load", rhythmMetric: "disk", forecast: "yes", quiet: 1 });
  assert.equal(odd.look, "summary");
  assert.equal(odd.range, "24h");
  assert.equal(odd.machine, "current");
  assert.deepEqual(odd.metrics, []);
  assert.equal(odd.rhythmMetric, "load");
  assert.equal(odd.forecast, true);
  assert.equal(odd.quiet, false);
  assert.equal(widgetConfigOf({ machine: "" }).machine, "current");
  assert.equal(widgetConfigOf({ machine: "x".repeat(201) }).machine, "current");
  assert.equal(widgetConfigOf({ machine: "x".repeat(200) }).machine, "x".repeat(200), "200 characters still fit");
  assert.equal(widgetConfigOf({ rhythmMetric: "memory" }).rhythmMetric, "memory");
  // Only load, memory and one disk by mount point; deduplicated, in place, at most six.
  assert.deepEqual(
    widgetConfigOf({ metrics: ["disk:/data", "load", "disk:/data", "cpu", "memory", "disk:bad", "disk:a/b", "disk:/a", "disk:/b", "disk:/c", "disk:/d", "disk:/e"] }).metrics,
    ["disk:/data", "load", "memory", "disk:/a", "disk:/b", "disk:/c"],
  );
});

test("the machine shown follows the config, the project and the machines that exist", () => {
  const projectOf = (machine: ReturnType<typeof machineOf>) => machine && machine !== "all" ? machine.projectId : machine;
  assert.equal(machineOf({ machine: "current" }, [], "a"), undefined);
  assert.equal(machineOf({ machine: "all" }, [host("a", "local", "local", false)], "a"), undefined, "nothing supported, nothing to show");
  const hosts = [host("a", "local"), host("b", "local"), host("c", "ssh-1", "ssh")];
  assert.equal(machineOf({ machine: "all" }, hosts, "a"), "all");
  assert.deepEqual(machineOf({ machine: "current" }, hosts, "b"), { id: "local", projectId: "b", kind: "local", name: "b" }, "the project's own machine");
  assert.equal(projectOf(machineOf({ machine: "current" }, hosts, null)), "a", "no context falls back to the first machine");
  assert.equal(projectOf(machineOf({ machine: "current" }, hosts, "gone")), "a", "an unknown context falls back to the first machine");
  assert.equal(projectOf(machineOf({ machine: "ssh-1" }, hosts, "a")), "c");
  assert.equal(machineOf({ machine: "removed-host" }, hosts, "a"), undefined);
  assert.equal(machinesOf(hosts, "a").length, 2, "two projects on one machine are one machine");
  assert.equal(projectOf(machineOf({ machine: "local" }, hosts, "a")), "a");
  assert.equal(projectOf(machineOf({ machine: "local" }, hosts, "b")), "b", "the preferred project names the machine");
});

test("a growing disk gets a straight-line forecast, and nothing else does", () => {
  const now = 1_800_000_000_000;
  const full = diskForecastOf(diskSeries(now, 91.5, 1.6), 93.1, 90, now);
  assert.equal(full?.target, "full");
  near(full?.days, 4.3, 0.2);
  near(full?.perDay, 1.6, 0.02);
  const limit = diskForecastOf(diskSeries(now, 88.7, 0.3), 89, 90, now);
  assert.equal(limit?.target, "limit");
  near(limit?.days, 3.3, 0.1);
  assert.equal(diskForecastOf(diskSeries(now, 89, 0), 89, 90, now), undefined, "a flat disk is no forecast");
  assert.equal(diskForecastOf(diskSeries(now, 91, -1.6), 89.4, 90, now), undefined, "a shrinking disk is no forecast");
  assert.equal(diskForecastOf(diskSeries(now, 90, 0.04), 90.04, 90, now), undefined, "too little growth to call");
  assert.equal(diskForecastOf(diskSeries(now, 88, 0.3).filter((_, index) => index % 30 === 0), 88.3, 90, now), undefined, "fewer than twelve readings");
  assert.equal(diskForecastOf(diskSeries(now, 88.9, 0.3, 2 * 60 * 60_000), 89.15, 90, now), undefined, "under twelve hours of readings");
  assert.equal(diskForecastOf(diskSeries(now, 80, 0.06), 80.06, 90, now), undefined, "further out than a month");
  assert.equal(diskForecastOf(diskSeries(now, 99, 0.3), 100, 90, now), undefined, "already full");
  const nulls = diskSeries(now, 91.5, 1.6).map((point, index): HistoryPoint => index % 3 === 0 ? [point[0], null, null, null] : point);
  const nullable = diskForecastOf(nulls, 93.1, 90, now);
  assert.equal(nullable?.target, "full");
  near(nullable?.perDay, 1.6, 0.02);
  const clean = diskForecastOf(diskSeries(now, 91.5, 1.6), 93.1, 90, now);
  const noisy = diskForecastOf([...diskSeries(now, 91.5, 1.6), [now - 8 * DAY_MS, null, null, 10], [now + STEP_MS, null, null, 10]], 93.1, 90, now);
  assert.deepEqual(noisy, clean, "readings from beyond seven days or the future are ignored");
});

test("the widget's tone is lost, warned, watching or fine, and only fine is quiet", () => {
  const base = snapshot([]);
  assert.equal(widgetToneOf(undefined, false), "lost");
  assert.equal(widgetToneOf(base, true), "lost");
  assert.equal(widgetToneOf(snapshot(["load"]), false), "warn");
  assert.equal(widgetToneOf(base, false, { target: "limit", days: 3, perDay: 0.5 }), "watch");
  assert.equal(widgetToneOf(base, false, { target: "limit", days: 8, perDay: 0.1 }), "ok");
  assert.equal(widgetToneOf(base, false), "ok");
  assert.equal(isQuiet({ quiet: true }, "ok"), true);
  assert.equal(isQuiet({ quiet: true }, "watch"), false);
  assert.equal(isQuiet({ quiet: true }, "warn"), false);
  assert.equal(isQuiet({ quiet: true }, "lost"), false);
  assert.equal(isQuiet({ quiet: false }, "ok"), false);
});

test("the vitals are the worst first, or exactly the person's pick in their order", () => {
  const snap = snapshot([]);
  const keys = (metrics: Parameters<typeof widgetVitalsOf>[2]) => widgetVitalsOf(snap, policy, metrics).map(vitalKey);
  assert.deepEqual(keys([]), vitalsOf(snap, policy).map(vitalKey), "an empty pick leaves the natural order");
  assert.deepEqual(keys([]), ["disk:/", "load", "disk:/data", "memory"], "the disk over its limit first, then by closeness");
  assert.deepEqual(keys(["memory", "disk:/data"]), ["memory", "disk:/data"]);
  assert.deepEqual(keys(["disk:/data"]), ["disk:/data"]);
  assert.deepEqual(keys(["disk:/nowhere"]), [], "a picked disk that is gone is left out");
  const [disk] = widgetVitalsOf(snap, policy, ["disk:/data"]);
  assert.equal(disk?.disk?.mount, "/data");
  assert.equal(vitalsOf(snap, policy).find((vital) => vital.kind === "disk" && vital.disk?.mount === "/data")?.over, false);
});

test("history columns are load, memory and disk, and missing values are skipped", () => {
  assert.equal(historyColumnOf("load"), 1);
  assert.equal(historyColumnOf("memory"), 2);
  assert.equal(historyColumnOf("disk"), 3);
  const points: HistoryPoint[] = [[10, 1, 40, 91], [20, null, 41, null], [30, 2, null, 88]];
  assert.deepEqual(historyValues(points, "load"), [[10, 1], [30, 2]]);
  assert.deepEqual(historyValues(points, "memory"), [[10, 40], [20, 41]]);
  assert.deepEqual(historyValues(points, "disk"), [[10, 91], [30, 88]]);
  assert.deepEqual(historyValues([], "load"), []);
});

test("the vertical scale keeps the limit in view", () => {
  const load = scaleOf([0.5, 2], "load", 1, false);
  assert.equal(load.floor, 0);
  assert.equal(load.top, Math.max(1.3, 2.2));
  assert.equal(scaleOf([0.5], "load", 1, false).top, 1.3, "a quiet machine still shows its limit");
  assert.deepEqual(scaleOf([50, 60], "memory", 85, false), { floor: 0, top: 100 }, "a percentage keeps the whole scale");
  assert.deepEqual(scaleOf([86, 89], "disk", 90, true), { floor: 70, top: 100 });
  assert.deepEqual(scaleOf([1, 2], "memory", 90, true), { floor: 0, top: 100 }, "the band never goes below zero");
});

test("the rhythm is seven local days, hour by hour, with one insight", () => {
  const now = local(2026, 4, 20, 14, 30);
  const points: HistoryPoint[] = [
    loadPoint(local(2026, 4, 12, 9), 99),
    loadPoint(local(2026, 4, 14, 1), 5),
    loadPoint(local(2026, 4, 20, 10, 5), 1),
    loadPoint(local(2026, 4, 20, 10, 45), 3),
    loadPoint(local(2026, 4, 20, 14, 10), 2),
    loadPoint(local(2026, 4, 20, 14, 40), 4),
  ];
  const model = rhythmOf(points, "load", 100, now);
  assert.equal(model.days.length, 7);
  assert.equal(model.days[0]!.start, local(2026, 4, 14), "oldest first");
  assert.equal(model.days[6]!.start, local(2026, 4, 20), "today is last and starts at local midnight");
  assert.deepEqual(model.days.map((day) => day.start), model.days.map((day) => day.start).slice().sort((a, b) => a - b));
  assert.equal(model.days[0]!.cells[1], 5);
  assert.equal(model.days[6]!.cells[10], 3, "a cell is the highest reading in that hour");
  assert.equal(model.days[6]!.cells[14], 2);
  assert.equal(model.days[6]!.cells[15], null, "an hour still to come is empty");
  assert.equal(model.days[6]!.cells[23], null);
  assert.equal(model.days[6]!.cells[0], null);
  assert.ok(!model.days.flatMap((day) => day.cells).includes(99), "readings before the first day are ignored");

  // A run of hours over the limit; the most recent day with one wins.
  const runs: HistoryPoint[] = [];
  for (const hour of [3, 4, 5, 6, 7]) runs.push(loadPoint(local(2026, 4, 17, hour), 20));
  for (const hour of [3, 4, 5]) runs.push(loadPoint(local(2026, 4, 19, hour), 13 + hour));
  runs.push(loadPoint(local(2026, 4, 19, 6), 1));
  assert.deepEqual(rhythmOf(runs, "load", 10, now).insight, { kind: "over", day: local(2026, 4, 19), fromHour: 3, toHour: 6, peak: 18 });

  // The same hour is each day's high on four days.
  const habit: HistoryPoint[] = [];
  for (const day of [14, 16, 17, 18]) {
    for (let hour = 0; hour < 12; hour += 1) habit.push(loadPoint(local(2026, 4, day, hour, 15), hour === 9 ? 30 + day % 10 : 10 + hour));
  }
  assert.deepEqual(rhythmOf(habit, "load", 100, now).insight, { kind: "daily", hour: 9, peak: 38, rest: 21 });

  // No habit, so the single highest hour of the week.
  const peaks: HistoryPoint[] = [];
  for (let hour = 0; hour < 12; hour += 1) peaks.push(loadPoint(local(2026, 4, 18, hour, 0), hour === 5 ? 50 : 5 + hour));
  for (let hour = 0; hour < 12; hour += 1) peaks.push(loadPoint(local(2026, 4, 19, hour, 0), hour === 7 ? 30 : 4 + hour));
  assert.deepEqual(rhythmOf(peaks, "load", 100, now).insight, { kind: "peak", day: local(2026, 4, 18), hour: 5, peak: 50 });

  const empty = rhythmOf([], "memory", 10, now);
  assert.equal(empty.days.length, 7);
  assert.equal(empty.insight, undefined);
});

test("the fleet puts warnings first, then what cannot be read, then the healthy", () => {
  const warnA = machine("warn-a", "alpha-warn");
  const warnB = machine("warn-b", "bravo");
  const lostError = machine("lost-error", "delta");
  const lostMissing = machine("lost-missing", "charlie");
  const okA = machine("ok-a", "alpha");
  const okB = machine("ok-b", "beta");
  const rows = fleetOf([okB, lostError, warnB, okA, warnA, lostMissing], new Map<string, { value?: MonitoringSnapshot; error?: string }>([
    ["ok-a", { value: snapshot([]) }],
    ["ok-b", { value: snapshot([]) }],
    ["warn-a", { value: snapshot(["load"]) }],
    ["warn-b", { value: snapshot(["disk"]) }],
    ["lost-error", { value: snapshot([]), error: "unreachable" }],
  ]));
  assert.deepEqual(rows.map((row) => row.machine.name), ["alpha-warn", "bravo", "charlie", "delta", "alpha", "beta"]);
  assert.deepEqual(rows.map((row) => row.tone), ["warn", "warn", "lost", "lost", "ok", "ok"]);
  for (const row of rows.filter((item) => item.tone === "lost")) {
    assert.equal(row.bars, undefined, "a machine that cannot be read has no bars");
    assert.equal(row.worst, undefined);
  }
  assert.equal(rows[2]!.sampledAt, undefined, "a missing snapshot has no sample time");
  assert.equal(rows[3]!.sampledAt, snapshot([]).sampledAt, "a failed read still knows when it was sampled");
  for (const row of rows.filter((item) => item.tone !== "lost")) {
    assert.deepEqual(row.bars?.map((bar) => bar.kind), ["load", "memory", "disk"]);
    for (const bar of row.bars ?? []) assert.ok(bar.fill >= 0 && bar.fill <= 100, `${bar.kind} fill ${bar.fill} is a percentage`);
  }
  assert.equal(rows[0]!.worst?.kind, "load", "the worst vital is the one nearest its limit");
  assert.equal(rows[0]!.machine, warnA);
});

test("the widget's size and gauges follow its panel and its box", () => {
  assert.equal(widgetSizeOf(500, 500, "compact"), "s");
  assert.equal(widgetSizeOf(100, 100, "large"), "l");
  assert.equal(widgetSizeOf(500, 500, "standard"), "m");
  assert.equal(widgetSizeOf(500, 500, "wide"), "m");
  assert.equal(widgetSizeOf(239, 500), "s");
  assert.equal(widgetSizeOf(400, 189), "s");
  assert.equal(widgetSizeOf(340, 400), "l");
  assert.equal(widgetSizeOf(500, 300), "m");
  assert.equal(widgetSizeOf(300, 400), "m", "wide enough to be large, not wide enough to try");
  assert.equal(gaugeCountOf(1000, "s"), 1);
  assert.equal(gaugeCountOf(400, "m"), 3);
  assert.equal(gaugeCountOf(250, "m"), 2);
  assert.equal(gaugeCountOf(100, "m"), 1);
  assert.equal(gaugeCountOf(1000, "l"), 3);
  assert.equal(chartsAreWide(560), true);
  assert.equal(chartsAreWide(559), false);
});
