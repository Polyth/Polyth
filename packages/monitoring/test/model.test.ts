import test from "node:test";
import assert from "node:assert/strict";
import type { HistoryPoint, MonitoringHost, MonitoringPolicy, MonitoringSnapshot } from "../src/contracts.ts";
import { bottleneckOf, chartOf, fill, loadTrendOf, logLinesOf, machinesOf, minutesOverLimit, vitalsOf } from "../widgets/model.ts";

const GiB = 1024 ** 3;
const host = (projectId: string, machineId: string, kind: MonitoringHost["kind"] = "local"): MonitoringHost => ({ projectId, name: projectId, kind, machineId, supported: true, fileTailsAvailable: true, hostLogsAvailable: true, canEditPolicy: true, processesAvailable: true });
const policy: MonitoringPolicy = { revision: 1, agentAccess: { metrics: true, services: true, logs: true, processes: false }, serviceUnits: [], logPaths: [], memoryWarningPercent: 85, loadWarningRatio: 1, diskWarningPercent: 90 };
const snapshot = (warnings: MonitoringSnapshot["warnings"]): MonitoringSnapshot => ({
  host: host("p", "local"), sampledAt: 0, warnings, services: [], servicesAvailable: true,
  metrics: { hostname: "watcher", platform: "linux", cpuCount: 4, load: [6.11, 7.82, 7.24], memoryTotal: 23.4 * GiB, memoryAvailable: 13.7 * GiB, uptimeSeconds: 1,
    disks: [{ mount: "/", size: 45 * GiB, used: 41 * GiB, available: 4.3 * GiB }, { mount: "/data", size: 150 * GiB, used: 123 * GiB, available: 20 * GiB }] },
});

test("the picker lists machines, not every project on them", () => {
  const hosts = [host("a", "local"), host("b", "local"), host("c", "ssh-1", "ssh")];
  assert.deepEqual(machinesOf(hosts, "a").map((item) => [item.id, item.projectId]), [["local", "a"], ["ssh-1", "c"]]);
  assert.deepEqual(machinesOf(hosts, "b").map((item) => item.projectId), ["b", "c"], "the current project reads its machine");
  const older = [{ ...host("x", "m"), machineId: undefined as unknown as string }];
  assert.equal(machinesOf(older, "x")[0]!.id, "x", "an older server still lists something");
});

test("vitals put what is over its limit first and place the limit on the meter", () => {
  const rows = vitalsOf(snapshot(["load", "disk"]), policy);
  assert.deepEqual(rows.map((row) => [row.kind, row.disk?.mount, row.over]), [
    ["load", undefined, true], ["disk", "/", true], ["disk", "/data", false], ["memory", undefined, false],
  ]);
  const load = rows[0]!;
  assert.ok(Math.abs(load.value - 1.955) < 1e-9, "the 5-minute load the warning compares");
  assert.ok(load.tick! < load.fill, "the limit sits before the reading");
  assert.ok(load.fill <= 100);
  const unknown = vitalsOf(snapshot(["disk"]), undefined);
  assert.equal(unknown.find((row) => row.kind === "memory")!.tick, undefined, "no invented limit while the policy loads");
  assert.equal(unknown.filter((row) => row.kind === "disk").every((row) => row.over), true);
});

test("the load trend compares the last minute with the 5-minute average", () => {
  assert.equal(loadTrendOf({ load: [6.11, 7.82, 7.24] }), "easing");
  assert.equal(loadTrendOf({ load: [9, 7.82, 7.24] }), "rising");
  assert.equal(loadTrendOf({ load: [7.8, 7.82, 7.24] }), "steady");
});

test("time over the limit is only claimed when the crossing is on record", () => {
  const minute = 60_000; const now = 100 * minute;
  const points = (values: Array<number | null>): HistoryPoint[] => values.map((value, i) => [now - (values.length - 1 - i) * minute, value, 1, 1]);
  assert.equal(minutesOverLimit(points([0.5, 0.9, 1.2, 1.5, 1.4]), 1, minute, now), 2);
  assert.equal(minutesOverLimit(points([1.2, 1.5, 1.4]), 1, minute, now), undefined, "it may have started before the record does");
  assert.equal(minutesOverLimit(points([1.5, 0.5]), 1, minute, now), undefined, "not over now");
  assert.equal(minutesOverLimit([], 1, minute, now), undefined);
  const gapped: HistoryPoint[] = [[now - 50 * minute, 0.5, 1, 1], [now - minute, 1.5, 1, 1], [now, 1.5, 1, 1]];
  assert.equal(minutesOverLimit(gapped, 1, minute, now), undefined, "a gap hides when it really crossed");
});

test("the bottleneck is named only when waiting is real", () => {
  assert.equal(bottleneckOf({ cpu: 59.33, io: 0.99, memory: 0.04 }), "cpu");
  assert.equal(bottleneckOf({ cpu: 2, io: 40, memory: 1 }), "io");
  assert.equal(bottleneckOf({ cpu: 2, io: 4, memory: 9.9 }), null);
});

test("the chart breaks at a gap, keeps the limit in view and reports the peak", () => {
  const minute = 60_000; const now = 60 * minute;
  const points: HistoryPoint[] = [[0, 0.5, 40, null], [minute, 3, 41, null], [30 * minute, 1, 42, 91], [31 * minute, 2, 42, 91], [60 * minute, 1.5, 42, 91]];
  const load = chartOf(points, "load", 1, minute, 60 * minute, now);
  assert.deepEqual(load.segments.map((segment) => segment.length), [2, 2, 1]);
  assert.deepEqual(load.peak, { value: 3, at: minute });
  assert.ok(load.limitY > 0 && load.limitY < 1);
  assert.equal(load.now?.value, 1.5); assert.equal(load.now?.atNow, true);
  const disk = chartOf(points, "disk", 90, minute, 60 * minute, now);
  assert.equal(disk.segments.flat().length, 3, "a machine with no disk reading then draws nothing then");
  assert.ok(Math.abs(disk.limitY - 0.1) < 1e-9, "percentages keep the whole scale");
  const quiet = chartOf([[0, 0.2, 1, 1]], "load", 1, minute, 60 * minute, 60 * minute);
  assert.ok(quiet.limitY > 0, "a quiet machine still shows its limit");
  assert.equal(quiet.now?.atNow, false, "an old reading is not drawn as now");
  assert.deepEqual(chartOf([], "load", 1, minute, 60 * minute, now).segments, []);
});

test("log lines lose the timestamp and host prefix, and problems are flagged", () => {
  const lines = logLinesOf("2026-11-04T21:00:07+0200 watcher kernel: oom-kill: task=chrome\n2026-11-04T21:00:08+02:00 watcher sshd[1]: error: too many tries\nplain line\n\nservice ready: 0 errors\nerrored out is not a word match\n", "watcher");
  assert.equal(lines.length, 5, "blank lines go");
  assert.equal(lines[0]!.text, "kernel: oom-kill: task=chrome");
  assert.equal(lines[0]!.at, Date.parse("2026-11-04T21:00:07+02:00"));
  assert.equal(lines[0]!.problem, true);
  assert.equal(lines[1]!.problem, true);
  assert.deepEqual(lines[2], { text: "plain line", problem: false });
  assert.equal(lines[3]!.problem, false, "saying there were no errors is no problem");
  assert.equal(lines[4]!.problem, false);
  assert.equal(logLinesOf("watcher kept", "").at(0)!.text, "watcher kept");
});

test("templates fill known holes and leave others visible", () => {
  assert.equal(fill("{a} of {b}", { a: 1, b: "two" }), "1 of two");
  assert.equal(fill("{a} {toString}", { a: 1 }), "1 {toString}");
});
