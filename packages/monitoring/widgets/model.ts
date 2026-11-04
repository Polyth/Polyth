// What the screen says, separated from how it draws it. No DOM, no strings.
import { diskPercent, loadRatio, memoryPercent, type DiskUsage, type HistoryPoint, type HostMetrics, type HostPressure, type MonitoringHost, type MonitoringPolicy, type MonitoringSnapshot } from "../src/contracts.ts";

export interface Machine {
  id: string;
  /** The project this machine is read through; its policy applies. */
  projectId: string;
  kind: MonitoringHost["kind"];
  name: string;
}

/** Projects on one machine show identical numbers, so the picker lists machines. */
export function machinesOf(hosts: readonly MonitoringHost[], preferredProjectId: string): Machine[] {
  const machines = new Map<string, Machine>();
  for (const host of hosts) {
    const id = host.machineId ?? host.projectId;
    if (!machines.has(id) || host.projectId === preferredProjectId) machines.set(id, { id, projectId: host.projectId, kind: host.kind, name: host.name });
  }
  return [...machines.values()];
}

export type VitalKind = "disk" | "load" | "memory";
export interface Vital {
  kind: VitalKind;
  disk?: DiskUsage;
  value: number;
  limit?: number;
  /** Meter position of the value and of its limit, 0 to 100. */
  fill: number;
  tick?: number;
  over: boolean;
}

/** Worst first: anything over its limit, then whatever is closest to one. */
export function vitalsOf(snapshot: MonitoringSnapshot, policy: MonitoringPolicy | undefined): Vital[] {
  const { metrics, warnings } = snapshot;
  const rows: Vital[] = [];
  for (const disk of metrics.disks ?? []) {
    const value = diskPercent(disk);
    const limit = policy?.diskWarningPercent;
    rows.push({ kind: "disk", disk, value, fill: value, over: limit === undefined ? warnings.includes("disk") : value >= limit, ...(limit === undefined ? {} : { limit, tick: limit }) });
  }
  const ratio = loadRatio(metrics);
  const loadLimit = policy?.loadWarningRatio;
  // Load has no ceiling, so its meter is scaled to keep the limit in view.
  const scale = Math.max((loadLimit ?? 1) * 2.5, ratio * 1.1);
  rows.push({ kind: "load", value: ratio, fill: ratio / scale * 100, over: warnings.includes("load"), ...(loadLimit === undefined ? {} : { limit: loadLimit, tick: loadLimit / scale * 100 }) });
  const memory = memoryPercent(metrics);
  const memoryLimit = policy?.memoryWarningPercent;
  rows.push({ kind: "memory", value: memory, fill: memory, over: warnings.includes("memory"), ...(memoryLimit === undefined ? {} : { limit: memoryLimit, tick: memoryLimit }) });
  const closeness = (row: Vital) => row.limit ? row.value / row.limit : 0;
  return rows.sort((a, b) => Number(b.over) - Number(a.over) || closeness(b) - closeness(a));
}

export type LoadTrend = "rising" | "easing" | "steady";
/** The 1-minute average against the 5-minute one that the warning uses. */
export function loadTrendOf(metrics: Pick<HostMetrics, "load">): LoadTrend {
  const [one, five] = metrics.load;
  return one > five * 1.1 ? "rising" : one < five * 0.9 ? "easing" : "steady";
}

/** Minutes the load has been over its limit, only if the crossing is on record. */
export function minutesOverLimit(points: readonly HistoryPoint[], limit: number, stepMs: number, now: number): number | undefined {
  let index = points.length - 1;
  const value = (at: number) => points[at]?.[1];
  if (index < 1 || (value(index) ?? -1) < limit) return undefined;
  while (index > 0 && (value(index - 1) ?? -1) >= limit && points[index]![0] - points[index - 1]![0] <= stepMs * 2.5) index -= 1;
  if (index === 0) return undefined;
  if (points[index]![0] - points[index - 1]![0] > stepMs * 2.5) return undefined;
  return Math.max(1, Math.round((now - points[index]![0]) / 60_000));
}

export type Bottleneck = "cpu" | "io" | "memory" | null;
/** Below this, waiting is ordinary scheduling rather than something to name. */
const BOTTLENECK_PERCENT = 10;
export function bottleneckOf(pressure: HostPressure): Bottleneck {
  const [name, value] = (Object.entries(pressure) as [keyof HostPressure, number][]).sort(([, a], [, b]) => b - a)[0]!;
  return value >= BOTTLENECK_PERCENT ? name : null;
}

export type ChartMetric = "load" | "memory" | "disk";
const COLUMN: Record<ChartMetric, 1 | 2 | 3> = { load: 1, memory: 2, disk: 3 };
export interface ChartModel {
  /** Line pieces with x and y in 0 to 1; a gap in the readings breaks the line. */
  segments: Array<Array<[x: number, y: number]>>;
  limitY: number;
  now?: { y: number; value: number; atNow: boolean };
  peak?: { value: number; at: number };
}
export function chartOf(points: readonly HistoryPoint[], metric: ChartMetric, limit: number, stepMs: number, spanMs: number, now: number): ChartModel {
  const column = COLUMN[metric];
  const present = points.flatMap((point) => point[column] === null ? [] : [{ at: point[0], value: point[column] as number }]);
  const peakValue = present.reduce((high, item) => Math.max(high, item.value), 0);
  // Percentages keep their whole scale; load grows to fit, always showing the limit.
  const top = metric === "load" ? Math.max(limit * 1.3, peakValue * 1.1) : 100;
  const y = (value: number) => 1 - Math.min(value, top) / top;
  // The right edge is the current step, so a fresh reading reaches it.
  const start = Math.floor(now / stepMs) * stepMs - spanMs;
  const segments: ChartModel["segments"] = [];
  let previous: number | undefined;
  for (const { at, value } of present) {
    if (previous === undefined || at - previous > stepMs * 2.5) segments.push([]);
    segments.at(-1)!.push([Math.max(0, (at - start) / spanMs), y(value)]);
    previous = at;
  }
  const last = present.at(-1);
  const peak = present.reduce<{ value: number; at: number } | undefined>((high, item) => !high || item.value >= high.value ? { value: item.value, at: item.at } : high, undefined);
  return { segments, limitY: y(limit), ...(last ? { now: { y: y(last.value), value: last.value, atNow: now - last.at <= stepMs * 2.5 } } : {}), ...(peak ? { peak } : {}) };
}

export interface LogLine { at?: number; text: string; problem: boolean }
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}):?(\d{2}|)\s+(.*)$/;
const PROBLEM = /\b(error|errors|err|fail|failed|failure|fatal|panic|critical|crit|denied|oom|oom-kill|segfault|exception|traceback)\b/i;
const NOT_A_PROBLEM = /\b(no|0|zero)\s+(errors?|failures?)\b/i;
/** Journal lines lead with a timestamp and the host name; both have a better place. */
export function logLinesOf(content: string, hostname = ""): LogLine[] {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const match = STAMP.exec(line);
    const at = match ? Date.parse(`${match[1]}${match[2]}:${match[3] || "00"}`) : NaN;
    const body = match && Number.isFinite(at) ? match[4]! : line;
    const text = hostname && body.startsWith(`${hostname} `) ? body.slice(hostname.length + 1) : body;
    return { ...(Number.isFinite(at) ? { at } : {}), text, problem: PROBLEM.test(text) && !NOT_A_PROBLEM.test(text) };
  });
}

export const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => Object.hasOwn(values, name) ? String(values[name]) : whole);
