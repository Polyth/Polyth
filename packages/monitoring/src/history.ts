// Recent readings per machine, so the chart can answer "since when?" on open.
// Three tiers keep the file small: a minute for an hour, five minutes for a day,
// half an hour for a week. Each step keeps the highest reading it saw, so a
// short peak survives the coarser tiers. Numbers only, in the Space's storage.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { atomicWriteSync, type ServerPackageHost } from "@polyth/plugins";
import type { Project, SpaceStorage } from "@polyth/contracts";
import { HISTORY_RANGES, loadRatio, memoryPercent, diskPercent, worstDisk, type HistoryPoint, type HistoryRange, type HostMetrics, type MetricHistory } from "./contracts.ts";

/** A write at most this often; a restart loses no more than this much. */
export const HISTORY_FLUSH_MS = 5 * 60_000;
const MACHINE_LIMIT = 64;
const RANGES = Object.keys(HISTORY_RANGES) as HistoryRange[];
const MACHINE_ID = /^(local|ssh-[0-9a-f]{16})$/;

/** Projects on one machine share its readings. Never reveals the connection id. */
export const machineIdOf = (project: Pick<Project, "remote">): string => project.remote
  ? `ssh-${createHash("sha256").update(project.remote.connectionId).digest("hex").slice(0, 16)}`
  : "local";

const rounded = (value: number): number => Math.round(value * 100) / 100;
export const readingOf = (metrics: HostMetrics): [load: number, memory: number, disk: number | null] => {
  const disk = worstDisk(metrics);
  return [rounded(loadRatio(metrics)), rounded(memoryPercent(metrics)), disk ? diskPercent(disk) : null];
};
const higher = (a: number | null, b: number | null): number | null => a === null ? b : b === null ? a : Math.max(a, b);

type Tiers = Record<HistoryRange, HistoryPoint[]>;
const validPoint = (value: unknown): value is HistoryPoint => Array.isArray(value) && value.length === 4
  && Number.isFinite(value[0]) && value.slice(1).every((item) => item === null || Number.isFinite(item));

export const historyStore = (storage: SpaceStorage) => {
  storage.packageDir("monitoring");
  const path = () => storage.path("packages/monitoring/history.json");
  let machines: Map<string, Tiers> | null = null;
  let dirty = false;
  let writtenAt = 0;
  const load = (): Map<string, Tiers> => {
    if (machines) return machines;
    machines = new Map();
    let text: string;
    try {
      text = readFileSync(path(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[monitoring] history unreadable; starting empty", error instanceof Error ? error.message : error);
      return machines;
    }
    try {
      const value = JSON.parse(text) as { v?: unknown; machines?: unknown };
      if (value.v !== 1 || !value.machines || typeof value.machines !== "object") throw new Error("unsupported history");
      for (const [id, tiers] of Object.entries(value.machines as Record<string, Partial<Tiers>>)) {
        if (!MACHINE_ID.test(id)) continue;
        machines.set(id, Object.fromEntries(RANGES.map((range) => [range, Array.isArray(tiers?.[range]) ? tiers[range].filter(validPoint) : []])) as Tiers);
      }
    } catch (error) {
      // A damaged file is an empty chart, never a failed reading.
      console.warn("[monitoring] history invalid; starting empty", error instanceof Error ? error.message : error);
      machines = new Map();
    }
    return machines;
  };
  const flush = (at: number): void => {
    if (!dirty) return;
    atomicWriteSync(path(), JSON.stringify({ v: 1, machines: Object.fromEntries(load()) }));
    dirty = false; writtenAt = at;
  };
  return {
    record(machineId: string, metrics: HostMetrics, at: number): void {
      const state = load();
      let tiers = state.get(machineId);
      if (!tiers) {
        if (state.size >= MACHINE_LIMIT) {
          const stalest = [...state.entries()].sort(([, a], [, b]) => (a["1h"].at(-1)?.[0] ?? 0) - (b["1h"].at(-1)?.[0] ?? 0))[0];
          if (stalest) state.delete(stalest[0]);
        }
        tiers = { "1h": [], "24h": [], "7d": [] };
        state.set(machineId, tiers);
      }
      const [loadValue, memory, disk] = readingOf(metrics);
      for (const range of RANGES) {
        const { stepMs, spanMs } = HISTORY_RANGES[range];
        const slot = Math.floor(at / stepMs) * stepMs;
        const points = tiers[range];
        const last = points.at(-1);
        if (last?.[0] === slot) { last[1] = higher(last[1], loadValue); last[2] = higher(last[2], memory); last[3] = higher(last[3], disk); }
        else points.push([slot, loadValue, memory, disk]);
        while (points.length && points[0]![0] < at - spanMs - stepMs) points.shift();
      }
      dirty = true;
      if (at - writtenAt >= HISTORY_FLUSH_MS) flush(at);
    },
    read(machineId: string, range: HistoryRange, at: number): MetricHistory {
      const { stepMs, spanMs } = HISTORY_RANGES[range];
      return { range, stepMs, points: (load().get(machineId)?.[range] ?? []).filter((point) => point[0] >= at - spanMs) };
    },
    flush,
  };
};
export type HistoryStore = ReturnType<typeof historyStore>;

/**
 * Keeps the Polyth server's own chart going while nobody is looking: one cheap
 * in-process reading a minute for each Space with a local project. SSH hosts are
 * never dialled for this; they gain history from the alert loop and open screens.
 */
export function createHistorySampler(
  host: Pick<ServerPackageHost, "projects">,
  recordLocal: (spaceId: string, metrics: HostMetrics) => void,
  readMetrics: () => Promise<HostMetrics>,
  intervalMs = 60_000,
) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const spaces = new Set((await host.projects.list()).flatMap((project) => project.spaceId && !project.remote ? [project.spaceId] : []));
      if (!spaces.size) return;
      const metrics = await readMetrics();
      for (const spaceId of spaces) recordLocal(spaceId, metrics);
    } catch (error) {
      console.warn("[monitoring] history sample skipped", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  return {
    start() { if (timer) return; void tick(); timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
  };
}
