import type { SessionSpawnTimingDto } from "@polyth/contracts";

// Bounded, in-memory spawn timing recorder. Stores only durations, a wall
// timestamp, a runtime hit flag and a harness id — never prompts, paths,
// errors or secrets. No timers or subscriptions; recording never throws.

export type SpawnTimingPhase = "runtimeAcquireMs" | "nativeSessionCreateMs" | "turnAdmissionMs";

export type SpawnTimingSnapshot = SessionSpawnTimingDto;

export type SpawnRuntimeMetadata = Partial<Pick<SpawnTimingSnapshot, "warmRuntimeHit" | "runtimeSpawnMs" | "harnessId">>;

export interface SpawnTelemetryOptions {
  now?: () => number;
  wallNow?: () => number;
  limit?: number;
}

/** Identifies one sample generation, so late phases cannot land on a re-begun or forgotten session. */
export type SpawnTelemetryToken = number;

export interface SpawnTelemetry {
  begin(sessionId: string): SpawnTelemetryToken;
  time<T>(sessionId: string, phase: SpawnTimingPhase, action: () => Promise<T>, token?: SpawnTelemetryToken): Promise<T>;
  update(sessionId: string, partial: SpawnRuntimeMetadata, token?: SpawnTelemetryToken): void;
  firstRuntimeEvent(sessionId: string, token?: SpawnTelemetryToken): void;
  get(sessionId: string): SpawnTimingSnapshot | undefined;
  forget(sessionId: string): void;
  /** Drops every sample (service dispose). Outstanding tokens become inert. */
  clear(): void;
  readonly size: number;
}

const DEFAULT_LIMIT = 256;
const MAX_HARNESS_ID = 128;

interface Entry {
  token: SpawnTelemetryToken;
  startMono: number;
  sample: SpawnTimingSnapshot;
}

function duration(from: number, to: number): number | undefined {
  const value = to - from;
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function safeRead(clock: () => number): number | undefined {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createSpawnTelemetry(options: SpawnTelemetryOptions = {}): SpawnTelemetry {
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const limit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : DEFAULT_LIMIT;
  const entries = new Map<string, Entry>();
  let nextToken = 1;

  const live = (sessionId: string, token?: SpawnTelemetryToken): Entry | undefined => {
    const entry = entries.get(sessionId);
    return entry && (token === undefined || entry.token === token) ? entry : undefined;
  };

  return {
    begin(sessionId) {
      const existing = entries.get(sessionId);
      if (existing) return existing.token;
      const startMono = safeRead(now);
      const startedAt = safeRead(wallNow);
      const token = nextToken++;
      if (startMono === undefined || startedAt === undefined) return token;
      while (entries.size >= limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(sessionId, { token, startMono, sample: { startedAt } });
      return token;
    },

    async time(sessionId, phase, action, token) {
      const bound = live(sessionId, token);
      const started = bound ? safeRead(now) : undefined;
      try {
        return await action();
      } finally {
        if (bound && started !== undefined) {
          const end = safeRead(now);
          const elapsed = end === undefined ? undefined : duration(started, end);
          // Only the first measurement per stage counts, and only for the same sample.
          if (elapsed !== undefined && entries.get(sessionId) === bound && bound.sample[phase] === undefined) {
            bound.sample[phase] = elapsed;
          }
        }
      }
    },

    update(sessionId, partial, token) {
      const entry = live(sessionId, token);
      if (!entry || !partial) return;
      if (typeof partial.warmRuntimeHit === "boolean") entry.sample.warmRuntimeHit = partial.warmRuntimeHit;
      if (typeof partial.runtimeSpawnMs === "number" && Number.isFinite(partial.runtimeSpawnMs)) {
        entry.sample.runtimeSpawnMs = Math.max(0, partial.runtimeSpawnMs);
      }
      if (typeof partial.harnessId === "string" && partial.harnessId) {
        entry.sample.harnessId = partial.harnessId.slice(0, MAX_HARNESS_ID);
      }
    },

    firstRuntimeEvent(sessionId, token) {
      const entry = live(sessionId, token);
      if (!entry || entry.sample.firstRuntimeEventMs !== undefined) return;
      const end = safeRead(now);
      const elapsed = end === undefined ? undefined : duration(entry.startMono, end);
      if (elapsed !== undefined) entry.sample.firstRuntimeEventMs = elapsed;
    },

    get(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? { ...entry.sample } : undefined;
    },

    forget(sessionId) {
      entries.delete(sessionId);
    },

    clear() {
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
