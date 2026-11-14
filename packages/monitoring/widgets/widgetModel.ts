// The Monitoring widget: what each look says, separated from how it draws it. No DOM, no strings.
import { type HistoryPoint, type HistoryRange, type MonitoringHost, type MonitoringPolicy, type MonitoringSnapshot } from "../src/contracts.ts";
import { machinesOf, vitalsOf, type Machine, type Vital, type VitalKind } from "./model.ts";

export const WIDGET_LOOKS = ["summary", "scales", "charts", "rhythm"] as const;
export type WidgetLook = typeof WIDGET_LOOKS[number];
export type RhythmMetric = "load" | "memory";
/** A vital the person picked: load, memory, or one disk by its mount point. */
export type WidgetMetric = "load" | "memory" | `disk:${string}`;

export interface MonitoringWidgetConfig {
  look: WidgetLook;
  /** `current`: the machine of the project the widget sits in. `all`: every machine. Otherwise a `MonitoringHost.machineId`. */
  machine: string;
  /** Empty: problems first. Otherwise exactly these, in this order. */
  metrics: WidgetMetric[];
  range: HistoryRange;
  /** Say when a growing disk reaches its limit, or fills once it is over it. */
  forecast: boolean;
  /** While all is well, only the dot and the machine's name. */
  quiet: boolean;
  rhythmMetric: RhythmMetric;
}

export const DEFAULT_WIDGET_CONFIG: Readonly<MonitoringWidgetConfig> = {
  look: "summary", machine: "current", metrics: [], range: "24h", forecast: true, quiet: false, rhythmMetric: "load",
};
const MAX_METRICS = 6;
const isMetric = (value: unknown): value is WidgetMetric =>
  value === "load" || value === "memory" || (typeof value === "string" && /^disk:\/\S{0,200}$/.test(value));

/** A stored config from any older or hand-edited layout becomes a whole, valid one. */
export function widgetConfigOf(raw: unknown): MonitoringWidgetConfig {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const metrics = Array.isArray(value.metrics) ? [...new Set(value.metrics.filter(isMetric))].slice(0, MAX_METRICS) : [];
  return {
    look: (WIDGET_LOOKS as readonly unknown[]).includes(value.look) ? value.look as WidgetLook : DEFAULT_WIDGET_CONFIG.look,
    machine: typeof value.machine === "string" && value.machine.trim() && value.machine.length <= 200 ? value.machine : DEFAULT_WIDGET_CONFIG.machine,
    metrics,
    range: value.range === "1h" || value.range === "24h" || value.range === "7d" ? value.range : DEFAULT_WIDGET_CONFIG.range,
    forecast: typeof value.forecast === "boolean" ? value.forecast : DEFAULT_WIDGET_CONFIG.forecast,
    quiet: typeof value.quiet === "boolean" ? value.quiet : DEFAULT_WIDGET_CONFIG.quiet,
    rhythmMetric: value.rhythmMetric === "memory" ? "memory" : "load",
  };
}

/**
 * The machine an instance shows. `undefined` means the chosen machine is gone
 * (its project removed or no longer readable), which the widget says plainly
 * instead of quietly showing another machine.
 */
export function machineOf(config: Pick<MonitoringWidgetConfig, "machine">, hosts: readonly MonitoringHost[], contextProjectId: string | null): Machine | "all" | undefined {
  const supported = hosts.filter((item) => item.supported);
  if (!supported.length) return undefined;
  if (config.machine === "all") return "all";
  const machines = machinesOf(supported, contextProjectId ?? "");
  if (config.machine === "current") {
    const here = supported.find((item) => item.projectId === contextProjectId);
    return machines.find((machine) => machine.id === (here?.machineId ?? here?.projectId)) ?? machines[0];
  }
  return machines.find((machine) => machine.id === config.machine);
}

export interface DiskForecast {
  /** `limit` while the disk is under its warning limit; `full` once it is over it. */
  target: "limit" | "full";
  days: number;
  /** Percentage points a day, from a straight line through the readings. */
  perDay: number;
}
const DAY_MS = 86_400_000;
/** Below this the disk is not really growing, and a forecast would be noise. */
const MIN_GROWTH_PER_DAY = 0.05;
/** Further out than this a straight line says nothing useful. */
const MAX_FORECAST_DAYS = 30;

/** When the fullest disk reaches its limit, or 100% once over it; only for a disk that is clearly growing. */
export function diskForecastOf(points: readonly HistoryPoint[], current: number, limit: number, now: number): DiskForecast | undefined {
  const readings = points.flatMap(([at, , , disk]) => disk === null || at < now - 7 * DAY_MS || at > now ? [] : [[at, disk] as const]);
  if (readings.length < 12 || readings.at(-1)![0] - readings[0]![0] < DAY_MS / 2 || current >= 100) return undefined;
  const meanX = readings.reduce((sum, [at]) => sum + at, 0) / readings.length;
  const meanY = readings.reduce((sum, [, value]) => sum + value, 0) / readings.length;
  let covariance = 0; let variance = 0;
  for (const [at, value] of readings) { covariance += (at - meanX) * (value - meanY); variance += (at - meanX) ** 2; }
  if (variance === 0) return undefined;
  const perDay = covariance / variance * DAY_MS;
  if (perDay < MIN_GROWTH_PER_DAY) return undefined;
  const target = current >= limit ? "full" : "limit";
  const days = ((target === "full" ? 100 : limit) - current) / perDay;
  return days > MAX_FORECAST_DAYS ? undefined : { target, days, perDay };
}

/** A forecast this close turns "all good" into "for now": words only, never the warning colour. */
export const WATCH_DAYS = 7;
export type WidgetTone = "ok" | "watch" | "warn" | "lost";
export function widgetToneOf(snapshot: MonitoringSnapshot | undefined, lost: boolean, forecast?: DiskForecast): WidgetTone {
  if (!snapshot || lost) return "lost";
  if (snapshot.warnings.length) return "warn";
  return forecast?.target === "limit" && forecast.days < WATCH_DAYS ? "watch" : "ok";
}
export const isQuiet = (config: Pick<MonitoringWidgetConfig, "quiet">, tone: WidgetTone): boolean => config.quiet && tone === "ok";

export const vitalKey = (vital: Vital): WidgetMetric => vital.kind === "disk" ? `disk:${vital.disk!.mount}` : vital.kind;
/** Problems first, or the person's own pick in their order; a picked disk that is gone is left out. */
export function widgetVitalsOf(snapshot: MonitoringSnapshot, policy: MonitoringPolicy | undefined, metrics: readonly WidgetMetric[]): Vital[] {
  const all = vitalsOf(snapshot, policy);
  if (!metrics.length) return all;
  return metrics.flatMap((metric) => all.filter((vital) => vitalKey(vital) === metric));
}

/** History keeps load per CPU, memory percent and the fullest disk's percent. */
export const historyColumnOf = (kind: VitalKind): 1 | 2 | 3 => kind === "load" ? 1 : kind === "memory" ? 2 : 3;
export const historyValues = (points: readonly HistoryPoint[], kind: VitalKind): Array<[at: number, value: number]> =>
  points.flatMap((point) => point[historyColumnOf(kind)] === null ? [] : [[point[0], point[historyColumnOf(kind)] as number]]);

/**
 * The vertical scale of a small chart. Load grows to fit and always shows its
 * limit. A percentage starts at zero, or, when `band` is asked for and the
 * caller labels it, at a round floor below both the readings and the limit.
 */
export function scaleOf(values: readonly number[], kind: VitalKind, limit: number, band: boolean): { floor: number; top: number } {
  const high = values.reduce((max, value) => Math.max(max, value), 0);
  if (kind === "load") return { floor: 0, top: Math.max(limit * 1.3, high * 1.1, 0.1) };
  if (!band) return { floor: 0, top: 100 };
  const low = values.reduce((min, value) => Math.min(min, value), limit);
  return { floor: Math.max(0, Math.floor((Math.min(low, limit) - 12) / 10) * 10), top: 100 };
}

export interface RhythmDay {
  /** Local midnight that starts the day. */
  start: number;
  /** The highest reading in each local hour; `null` for no reading or an hour still to come. */
  cells: Array<number | null>;
}
export type RhythmInsight =
  | { kind: "over"; day: number; fromHour: number; toHour: number; peak: number }
  | { kind: "daily"; hour: number; peak: number; rest: number }
  | { kind: "peak"; day: number; hour: number; peak: number };
export interface RhythmModel { days: RhythmDay[]; insight?: RhythmInsight }
/** The same hour has to be the day's high this often before it is called a habit. */
const DAILY_HABIT_DAYS = 4;

/** The last seven local days, oldest first and today last, hour by hour. */
export function rhythmOf(points: readonly HistoryPoint[], metric: RhythmMetric, limit: number, now: number): RhythmModel {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days: RhythmDay[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const start = new Date(today); start.setDate(today.getDate() - back);
    days.push({ start: start.getTime(), cells: Array.from({ length: 24 }, () => null) });
  }
  const first = days[0]!.start;
  for (const [at, value] of historyValues(points, metric)) {
    if (at < first || at > now) continue;
    const when = new Date(at);
    const midnight = new Date(when); midnight.setHours(0, 0, 0, 0);
    const day = days.find((item) => item.start === midnight.getTime());
    if (!day) continue;
    const hour = when.getHours();
    day.cells[hour] = Math.max(day.cells[hour] ?? -Infinity, value);
  }
  return { days, ...withInsight(days, limit) };
}

function withInsight(days: readonly RhythmDay[], limit: number): { insight?: RhythmInsight } {
  // An exception first: the most recent run of hours over the limit.
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const { start, cells } = days[index]!;
    let best: Extract<RhythmInsight, { kind: "over" }> | undefined;
    for (let hour = 0; hour < 24; hour += 1) {
      if ((cells[hour] ?? -Infinity) < limit) continue;
      let end = hour; let peak = cells[hour]!;
      while (end + 1 < 24 && (cells[end + 1] ?? -Infinity) >= limit) { end += 1; peak = Math.max(peak, cells[end]!); }
      if (!best || end + 1 - hour > best.toHour - best.fromHour || (end + 1 - hour === best.toHour - best.fromHour && peak > best.peak)) best = { kind: "over", day: start, fromHour: hour, toHour: end + 1, peak };
      hour = end;
    }
    if (best) return { insight: best };
  }
  // Then a habit: the same hour is the day's high on most days.
  const highs = new Map<number, number>();
  let counted = 0;
  for (const { cells } of days) {
    const present = cells.flatMap((value, hour) => value === null ? [] : [[hour, value] as const]);
    if (present.length < 12) continue;
    counted += 1;
    const [hour] = present.reduce((high, item) => item[1] > high[1] ? item : high);
    highs.set(hour, (highs.get(hour) ?? 0) + 1);
  }
  const habit = [...highs].sort(([, a], [, b]) => b - a)[0];
  if (counted >= DAILY_HABIT_DAYS && habit && habit[1] >= DAILY_HABIT_DAYS) {
    const [hour] = habit;
    let peak = -Infinity; let rest = -Infinity;
    for (const { cells } of days) cells.forEach((value, at) => { if (value === null) return; if (at === hour) peak = Math.max(peak, value); else rest = Math.max(rest, value); });
    if (Number.isFinite(peak) && Number.isFinite(rest)) return { insight: { kind: "daily", hour, peak, rest } };
  }
  // Otherwise the single highest hour of the week.
  let top: Extract<RhythmInsight, { kind: "peak" }> | undefined;
  for (const { start, cells } of days) cells.forEach((value, hour) => { if (value !== null && (!top || value > top.peak)) top = { kind: "peak", day: start, hour, peak: value }; });
  return top ? { insight: top } : {};
}

export interface FleetRow {
  machine: Machine;
  tone: Exclude<WidgetTone, "watch">;
  /** The vital nearest its limit; absent while the machine cannot be read. */
  worst?: Vital;
  /** Load, memory and fullest disk as 0 to 100 bar heights, and whether each is over its limit. */
  bars?: Array<{ kind: VitalKind; fill: number; over: boolean }>;
  sampledAt?: number;
}
const FLEET_ORDER: Record<FleetRow["tone"], number> = { warn: 0, lost: 1, ok: 2 };
/** Every machine, the ones that need a look first. A fleet reads no history, so it never forecasts. */
export function fleetOf(machines: readonly Machine[], readings: ReadonlyMap<string, { value?: MonitoringSnapshot; error?: string }>): FleetRow[] {
  return machines.map((machine): FleetRow => {
    const reading = readings.get(machine.id);
    const snapshot = reading?.value;
    const tone = widgetToneOf(snapshot, !!reading?.error);
    if (!snapshot || tone === "lost") return { machine, tone: "lost", ...(snapshot ? { sampledAt: snapshot.sampledAt } : {}) };
    const vitals = vitalsOf(snapshot, undefined);
    const pick = (kind: VitalKind) => vitals.filter((vital) => vital.kind === kind).sort((a, b) => b.fill - a.fill)[0];
    const bars = (["load", "memory", "disk"] as const).flatMap((kind) => { const vital = pick(kind); return vital ? [{ kind, fill: Math.min(100, Math.max(0, vital.fill)), over: vital.over }] : []; });
    return { machine, tone: tone === "warn" ? "warn" : "ok", worst: vitals[0], bars, sampledAt: snapshot.sampledAt };
  }).sort((a, b) => FLEET_ORDER[a.tone] - FLEET_ORDER[b.tone] || a.machine.name.localeCompare(b.machine.name));
}

export type WidgetSize = "s" | "m" | "l";
/** The phone panel names its size; everywhere else the box decides. */
export function widgetSizeOf(width: number, height: number, panelSize?: string): WidgetSize {
  if (panelSize === "compact") return "s";
  if (panelSize === "large") return "l";
  if (panelSize === "standard" || panelSize === "wide") return "m";
  if (width < 240 || height < 190) return "s";
  return height >= 400 && width >= 340 ? "l" : "m";
}
export const gaugeCountOf = (width: number, size: WidgetSize): number => size === "s" ? 1 : Math.max(1, Math.min(3, Math.floor(width / 116)));
export const chartsAreWide = (width: number): boolean => width >= 560;

/** A widget is on screen for hours, so it asks less often than the Monitoring window. */
export const WIDGET_POLL_MS: Readonly<Record<MonitoringHost["kind"], number>> = { local: 15_000, ssh: 30_000 };
export const WIDGET_HISTORY_POLL_MS = 300_000;
