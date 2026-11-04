// The incident chat a project's warnings opened survives a restart: this keeps
// only the chat id and two timestamps per project, in the project's Space, so a
// new process notifies the same chat instead of opening a duplicate. A project
// leaves the record once no warning of any type was seen for the quiet window.
import { readFileSync } from "node:fs";
import { atomicWriteSync } from "@polyth/plugins";
import type { SpaceStorage } from "@polyth/contracts";

/** A project's incident ends after this long without any warning of any type. */
export const INCIDENT_QUIET_MS = 2 * 60 * 60_000;
/** A warning-only `lastWarningAt` refresh is written at most this often. */
export const INCIDENT_WRITE_INTERVAL_MS = 5 * 60_000;

export interface IncidentRecord {
  /** Chat this package opened for the project's incident. */
  sessionId: string;
  openedAt: number;
  /** Last sample where the project had any warning at all. */
  lastWarningAt: number;
}

/** `space:project` state is never shared across Spaces; the file lives per Space. */
export const incidentStore = (storage: SpaceStorage, quietMs = INCIDENT_QUIET_MS) => {
  storage.packageDir("monitoring");
  const path = () => storage.path("packages/monitoring/incidents.json");
  const projectId = (value: string): boolean => value.length > 0 && value.length <= 200 && value !== "__proto__" && value !== "constructor";
  const record = (value: unknown): IncidentRecord | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { sessionId, openedAt, lastWarningAt } = value as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return undefined;
    if (!Number.isFinite(openedAt) || !Number.isFinite(lastWarningAt)) return undefined;
    return { sessionId, openedAt: openedAt as number, lastWarningAt: lastWarningAt as number };
  };
  let records: Record<string, IncidentRecord> | null = null;
  /** Last time this store wrote its file, for the `lastWarningAt` throttle. */
  let writtenAt = 0;
  const read = (): Record<string, IncidentRecord> => {
    if (records) return records;
    records = Object.create(null) as Record<string, IncidentRecord>;
    let text: string;
    try {
      text = readFileSync(path(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[monitoring] incident state unreadable; starting empty", error instanceof Error ? error.message : error);
      }
      return records;
    }
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== "object" || (value as { v?: unknown }).v !== 1) throw new Error("unsupported incident state");
      const projects = (value as { projects?: unknown }).projects;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw new Error("invalid incident projects");
      for (const [id, item] of Object.entries(projects as Record<string, unknown>)) {
        const valid = record(item);
        if (projectId(id) && valid) records[id] = valid;
      }
    } catch (error) {
      // One warning, never a throw out of a tick: a damaged file is empty state.
      console.warn("[monitoring] incident state invalid; starting empty", error instanceof Error ? error.message : error);
      records = Object.create(null) as Record<string, IncidentRecord>;
    }
    return records;
  };
  const changed = (at: number) => {
    const state = read();
    for (const [id, item] of Object.entries(state)) if (at - item.lastWarningAt >= quietMs) delete state[id];
    atomicWriteSync(path(), `${JSON.stringify({ v: 1, projects: state }, null, 2)}\n`);
    writtenAt = at;
  };
  const live = (item: IncidentRecord | undefined, at: number): item is IncidentRecord => !!item && at - item.lastWarningAt < quietMs;
  return {
    /** The project's incident inside its window, if any. Reads do not write. */
    active(at: number, id: string): IncidentRecord | undefined {
      const item = read()[id];
      return live(item, at) ? item : undefined;
    },
    open(id: string, sessionId: string, at: number): IncidentRecord {
      const item = { sessionId, openedAt: at, lastWarningAt: at };
      Object.defineProperty(read(), id, { value: item, enumerable: true, configurable: true, writable: true });
      changed(at);
      return item;
    },
    /** A warning was sampled: keep the incident alive, writing at most every 5 min. */
    touch(id: string, at: number): void {
      const item = read()[id];
      if (!live(item, at)) return;
      item.lastWarningAt = at;
      if (at - writtenAt >= INCIDENT_WRITE_INTERVAL_MS) changed(at);
    },
    /** Incidents still inside their quiet window, for the package-wide chat cap. */
    openCount(at: number): number {
      return Object.values(read()).filter((item) => live(item, at)).length;
    },
  };
};

export type IncidentStore = ReturnType<typeof incidentStore>;
