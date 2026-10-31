import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type {
  Project,
  SessionEvent,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import { buildUsageStatsReport, type UsageSessionMetadata } from "./aggregate.ts";
import { collectSessionObservations } from "./collect.ts";
import { localDateKey } from "./time.ts";
import type {
  UsageGroupSummary,
  UsageObservation,
  UsageProjectInfo,
  UsageStatsIdentity,
  UsageStatsQuery,
  UsageStatsReport,
} from "./contracts.ts";

export interface UsageAnalyticsSource {
  /** The whole Space's sessions: the index is shared by everyone in it. */
  projections(space: SpaceContext, scope?: UsageSyncScope): Promise<SessionProjection[]>;
  events(space: SpaceContext, sessionId: string): Promise<SessionEvent[]>;
  latestSeq?(space: SpaceContext, sessionId: string): Promise<number>;
  /** The sessions this reader may open; undefined when they see the whole
   *  Space. Reports and observations only ever include these. */
  visibleSessions?(space: SpaceContext): Promise<ReadonlySet<string> | undefined>;
}

export interface UsageAnalyticsServiceOptions {
  source: UsageAnalyticsSource;
  /** Return a validated, Space-owned directory for the analytics checkpoint. */
  storageDir?: (space: SpaceContext) => string;
  now?: () => number;
  serverInstanceId?: string;
  /** Bounds a single sync wave; the default is deliberately conservative. */
  concurrency?: number;
  /** Live name of a registered harness, e.g. an account's `Claude Code · Work`.
   * Harnesses it does not name keep their static label. */
  harnessLabel?: (harnessId: string) => string | undefined;
}

interface SessionState {
  metadata: UsageSessionMetadata;
  fingerprint: string;
  seq: number;
  observations: UsageObservation[];
}

interface CachedReport {
  revision: number;
  metadataRevision: number;
  members: number;
  /** Fingerprint of the sessions the reader could open. */
  visible: string;
  day: string;
  report: UsageStatsReport;
}

interface SpaceState {
  sessions: Map<string, SessionState>;
  lastSyncAt: number;
  dirty: boolean;
  /** Bumped whenever a session's observations change (added, removed, re-collected). */
  revision: number;
  /** Bumped when only a session's title or status changed. A built report stays
   * valid across these: its session rows are relabelled instead of rebuilt. */
  metadataRevision: number;
  /** Built reports by exact query, valid while `revision` holds. */
  reports: Map<string, CachedReport>;
}

/** The checkpoint is a cold-start cache; writing it is a full serialization. */
const PERSIST_DELAY_MS = 10_000;
const MAX_CACHED_REPORTS = 32;

/**
 * A cached report rebuilt "now" differs only in its clock fields: no
 * observation changed, and the local day (which fixes every preset range and
 * the open end of the monthly all-time chart) is the same.
 */
const restampReport = (report: UsageStatsReport, now: number): UsageStatsReport => {
  const restamped: UsageStatsReport = {
    ...report,
    generatedAt: now,
    coverage: { ...report.coverage, syncedAt: now },
  };
  if (report.query.range !== "all") return restamped;
  const last = report.chart.buckets.length - 1;
  return {
    ...restamped,
    effective: { ...report.effective, to: now + 1 },
    chart: {
      ...report.chart,
      buckets: report.chart.buckets.map((bucket, index) => index === last ? { ...bucket, end: now + 1 } : bucket),
    },
  };
};

/**
 * A built report names sessions only in its drill-down rows. When nothing but
 * a title or status changed, those rows are relabelled from the current
 * metadata rather than re-aggregating every observation in the Space.
 */
const relabelReport = (
  report: UsageStatsReport,
  metadata: ReadonlyMap<string, UsageSessionMetadata>,
): UsageStatsReport => ({
  ...report,
  sessions: report.sessions.map((row) => {
    const current = metadata.get(row.id);
    if (!current || (current.title === row.title && current.status === row.status)) return row;
    return { ...row, title: current.title, status: current.status };
  }),
  turns: report.turns.map((row) => {
    const title = metadata.get(row.sessionId)?.title;
    return title === undefined || title === row.sessionTitle ? row : { ...row, sessionTitle: title };
  }),
});

interface SyncedScope {
  state: SpaceState;
  /** The Space revision this materialization observed. A later sync may have
   * advanced `state.revision` before the report is built. */
  revision: number;
  metadataRevision: number;
  metadata: Map<string, UsageSessionMetadata>;
  observations: UsageObservation[];
}

interface UsageSyncScope {
  projectId?: string;
  sessionIds?: ReadonlySet<string>;
}

export interface UsageAnalyticsService {
  readonly serverInstanceId: string;
  identity(space: SpaceContext): UsageStatsIdentity;
  query(
    space: SpaceContext,
    projects: readonly Project[],
    query: UsageStatsQuery,
  ): Promise<UsageStatsReport>;
  /** Every Space observation at or after `from`, from the same synced index
   *  the dashboard reads. Callers aggregate; the array is a fresh copy. */
  observations(space: SpaceContext, from: number): Promise<UsageObservation[]>;
  /** Clear a tenant index after an external destructive lifecycle change. */
  invalidate(spaceId?: string): void;
  stop(): void;
}

/**
 * Only the projection fields that `collectSessionObservations` reads. Status
 * and `updatedAt` are deliberately absent: a working session flips them on
 * every tick, and re-reading its whole event log for that made every dashboard
 * query pay for every live session. New events are caught by the tail check.
 */
const projectionFingerprint = (projection: SessionProjection): string => JSON.stringify([
  projection.projectId,
  projection.spaceId ?? "",
  projection.parentId ?? "",
  projection.lastTurnAt ?? 0,
  projection.resolvedHarnessId ?? "",
  projection.model?.providerID ?? "",
  projection.model?.modelID ?? "",
  projection.model?.variant ?? "",
  projection.tokenTotals?.input ?? null,
  projection.tokenTotals?.output ?? null,
  projection.tokenTotals?.reasoning ?? null,
  projection.tokenTotals?.cacheRead ?? null,
  projection.tokenTotals?.cacheWrite ?? null,
  projection.costTotal ?? null,
]);

/**
 * Checkpoints written before the fingerprint dropped status/updatedAt (index 3
 * and 4 of a 16-field array) are upgraded in place, so a deploy does not
 * re-read every event log in the Space once.
 */
const upgradeLegacyFingerprint = (stored: string): string => {
  if (!stored.startsWith("[")) return stored;
  try {
    const fields = JSON.parse(stored) as unknown;
    if (!Array.isArray(fields) || fields.length !== 16) return stored;
    return JSON.stringify([...fields.slice(0, 3), ...fields.slice(5)]);
  } catch {
    return stored;
  }
};

const isObservation = (value: unknown): value is UsageObservation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<UsageObservation>;
  const tokens = row.tokens as Record<string, unknown> | undefined;
  const tokenKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
  return typeof row.id === "string" &&
    typeof row.timestamp === "number" &&
    Number.isFinite(row.timestamp) &&
    typeof row.projectId === "string" &&
    typeof row.sessionId === "string" &&
    !!tokens && typeof tokens === "object" &&
    tokenKeys.every((key) => {
      const token = tokens[key];
      return token === null || (typeof token === "number" && Number.isFinite(token) && token >= 0);
    }) &&
    (row.quality === "exact" || row.quality === "derived" || row.quality === "estimated");
};

const readPersisted = (file: string, spaceId: string): Map<string, SessionState> => {
  const result = new Map<string, SessionState>();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      version?: unknown;
      spaceId?: unknown;
      sessions?: unknown;
    };
    if (raw.version !== 1 || raw.spaceId !== spaceId || !Array.isArray(raw.sessions)) return result;
    for (const value of raw.sessions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as {
        id?: unknown;
        title?: unknown;
        status?: unknown;
        fingerprint?: unknown;
        seq?: unknown;
        observations?: unknown;
      };
      if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.fingerprint !== "string") continue;
      if (typeof row.seq !== "number" || !Array.isArray(row.observations)) continue;
      const observations = row.observations.filter(isObservation);
      result.set(row.id, {
        metadata: {
          id: row.id,
          title: row.title,
          status: typeof row.status === "string"
            ? row.status as UsageSessionMetadata["status"]
            : "idle",
        },
        fingerprint: row.fingerprint,
        seq: row.seq,
        observations,
      });
    }
  } catch {
    // A missing or interrupted checkpoint is not an analytics failure. The
    // canonical event log remains authoritative and will be backfilled.
  }
  return result;
};

const projectInfo = (projects: readonly Project[]): UsageProjectInfo[] =>
  projects.map((project) => ({ id: project.id, name: project.name, path: project.path }));

export function createUsageAnalyticsService(
  options: UsageAnalyticsServiceOptions,
): UsageAnalyticsService {
  const now = options.now ?? Date.now;
  const serverInstanceId = options.serverInstanceId ?? randomUUID();
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8));
  const labelHarness = (group: UsageGroupSummary): UsageGroupSummary => {
    let label: string | undefined;
    try {
      label = options.harnessLabel?.(group.id)?.trim();
    } catch {
      label = undefined;
    }
    return label ? { ...group, label } : group;
  };
  const spaces = new Map<string, SpaceState>();
  const contexts = new Map<string, SpaceContext>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const syncTails = new Map<string, Promise<void>>();
  const requests = new Map<string, Promise<UsageStatsReport>>();
  const runWorkers = async (count: number, worker: () => Promise<void>): Promise<void> => {
    // A failed worker must not release the Space lock while siblings mutate it.
    const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, count) }, worker));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };

  const fileFor = (space: SpaceContext): string | undefined => {
    const directory = options.storageDir?.(space);
    return directory ? `${directory}/analytics-v1.json` : undefined;
  };

  const stateFor = (space: SpaceContext): SpaceState => {
    const existing = spaces.get(space.spaceId);
    if (existing) return existing;
    const file = fileFor(space);
    const state: SpaceState = {
      sessions: file ? readPersisted(file, space.spaceId) : new Map(),
      lastSyncAt: 0,
      dirty: false,
      revision: 0,
      metadataRevision: 0,
      reports: new Map(),
    };
    spaces.set(space.spaceId, state);
    contexts.set(space.spaceId, space);
    return state;
  };

  const persist = (space: SpaceContext, state: SpaceState): void => {
    const file = fileFor(space);
    if (!file || !state.dirty) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      atomicWriteSync(file, JSON.stringify({
        version: 1,
        spaceId: space.spaceId,
        sessions: [...state.sessions.entries()].map(([id, session]) => ({
          id,
          title: session.metadata.title,
          status: session.metadata.status,
          fingerprint: session.fingerprint,
          seq: session.seq,
          observations: session.observations,
        })),
      }));
      state.dirty = false;
    } catch {
      // Analytics remains available from the in-memory index; persistence is a
      // performance optimization and never a reason to blank the report.
    }
  };

  const schedulePersist = (space: SpaceContext, state: SpaceState): void => {
    if (!fileFor(space)) return;
    const previous = timers.get(space.spaceId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      timers.delete(space.spaceId);
      persist(space, state);
    }, PERSIST_DELAY_MS);
    timer.unref?.();
    timers.set(space.spaceId, timer);
  };

  const syncSpaceUnlocked = async (
    space: SpaceContext,
    scope?: UsageSyncScope,
  ): Promise<SyncedScope> => {
    const state = stateFor(space);
    const listed = await options.source.projections(space, scope);
    const projections = scope?.sessionIds
      ? listed.filter((projection) => scope.sessionIds!.has(projection.id))
      : listed;
    const authoritativeListing = scope === undefined;
    const currentIds = new Set<string>();
    const changed: SessionProjection[] = [];
    let projectionCursor = 0;
    const inspectProjection = async (): Promise<void> => {
      while (projectionCursor < projections.length) {
        const projection = projections[projectionCursor++]!;
        // Keep the tenant fence even for alternate analytics sources.
        if (projection.spaceId && projection.spaceId !== space.spaceId) continue;
        currentIds.add(projection.id);
        const fingerprint = projectionFingerprint(projection);
        const previous = state.sessions.get(projection.id);
        if (previous && previous.fingerprint !== fingerprint && upgradeLegacyFingerprint(previous.fingerprint) === fingerprint) {
          previous.fingerprint = fingerprint;
          state.dirty = true;
        }
        if (!previous || previous.fingerprint !== fingerprint) {
          changed.push(projection);
        } else {
          // Check durable tails even when projection side effects lag behind.
          const latest = options.source.latestSeq ? await options.source.latestSeq(space, projection.id) : previous.seq;
          if (latest > previous.seq) changed.push(projection);
          const metadata = { id: projection.id, title: projection.title, status: projection.status };
          if (previous.metadata.title !== metadata.title || previous.metadata.status !== metadata.status) {
            state.dirty = true;
            state.metadataRevision += 1;
          }
          previous.metadata = metadata;
        }
      }
    };
    await runWorkers(projections.length, inspectProjection);
    if (authoritativeListing) {
      for (const id of [...state.sessions.keys()]) {
        if (!currentIds.has(id)) {
          state.sessions.delete(id);
          state.dirty = true;
          state.revision += 1;
        }
      }
    } else if (scope?.sessionIds) {
      for (const id of scope.sessionIds) {
        if (!currentIds.has(id) && state.sessions.delete(id)) {
          state.dirty = true;
          state.revision += 1;
        }
      }
    } else if (scope?.projectId) {
      for (const [id, session] of [...state.sessions.entries()]) {
        const belongsToProject = session.observations.some((observation) =>
          observation.projectId === scope.projectId);
        if (belongsToProject && !currentIds.has(id)) {
          state.sessions.delete(id);
          state.dirty = true;
          state.revision += 1;
        }
      }
    }

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < changed.length) {
        const projection = changed[cursor++]!;
        const events = await options.source.events(space, projection.id);
        const observations = collectSessionObservations(projection, events);
        state.sessions.set(projection.id, {
          metadata: { id: projection.id, title: projection.title, status: projection.status },
          fingerprint: projectionFingerprint(projection),
          seq: events.at(-1)?.seq ?? 0,
          observations,
        });
        state.dirty = true;
        state.revision += 1;
      }
    };
    await runWorkers(changed.length, worker);
    state.lastSyncAt = now();
    // A small scoped report must not copy the entire warm Space index.
    const metadata = new Map<string, UsageSessionMetadata>();
    const observations: UsageObservation[] = [];
    for (const id of currentIds) {
      const session = state.sessions.get(id);
      if (!session) continue;
      metadata.set(id, session.metadata);
      for (const observation of session.observations) observations.push(observation);
    }
    if (state.dirty) schedulePersist(space, state);
    return { state, revision: state.revision, metadataRevision: state.metadataRevision, metadata, observations };
  };

  /** The part of a materialization one reader may see. */
  const readable = (synced: SyncedScope, visible: ReadonlySet<string> | undefined) => {
    if (!visible) return { metadata: synced.metadata, observations: synced.observations, fingerprint: "" };
    const metadata = new Map([...synced.metadata].filter(([id]) => visible.has(id)));
    const observations = synced.observations.filter((observation) => visible.has(observation.sessionId));
    const fingerprint = createHash("sha256").update([...metadata.keys()].sort().join("\n")).digest("hex");
    return { metadata, observations, fingerprint };
  };

  // A report is built from one coherent materialization. Serialize sync waves
  // per Space so a slower older projection read cannot overwrite a newer event
  // read that happened to finish later.
  const syncSpace = async (
    space: SpaceContext,
    scope?: UsageSyncScope,
  ): Promise<SyncedScope> => {
    const previous = syncTails.get(space.spaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    syncTails.set(space.spaceId, current);
    await previous;
    try {
      return await syncSpaceUnlocked(space, scope);
    } finally {
      release();
      if (syncTails.get(space.spaceId) === current) syncTails.delete(space.spaceId);
    }
  };

  return {
    serverInstanceId,
    identity(space) {
      // The client asks for identity right before its first report. Parsing a
      // cold checkpoint (hundreds of milliseconds for a large Space) off this
      // call means the report request that follows finds a warm index.
      if (!spaces.has(space.spaceId)) {
        const warm = setImmediate(() => {
          try { stateFor(space); } catch { /* the report request reads it itself */ }
        });
        warm.unref?.();
      }
      return { serverInstanceId, spaceId: space.spaceId };
    },
    query(space, projects, query) {
      // Share only concurrent exact requests, never a timed stale report. Each
      // subsequent request still verifies projections and durable event tails.
      // People in one Space can open different chats, so reports are per reader.
      const key = JSON.stringify([space.spaceId, space.userId, projectInfo(projects), query]);
      const pending = requests.get(key);
      if (pending) return pending;
      const request = (async () => {
        const visible = await options.source.visibleSessions?.(space);
        // Never read a session the reader may not open on their behalf.
        const sessionIds = query.sessionIds?.length && visible
          ? query.sessionIds.filter((id) => visible.has(id))
          : query.sessionIds;
        const syncScope: UsageSyncScope | undefined = query.sessionIds?.length
          ? { sessionIds: new Set(sessionIds) }
          : query.projectIds?.length === 1
            ? { projectId: query.projectIds[0] }
            : undefined;
        const synced = await syncSpace(space, syncScope);
        const at = now();
        const day = localDateKey(at, query.timezone);
        const { state } = synced;
        const { metadata, observations, fingerprint } = readable(synced, visible);
        const cached = state.reports.get(key);
        let report: UsageStatsReport;
        if (cached && cached.revision === synced.revision && cached.members === metadata.size
          && cached.visible === fingerprint && cached.day === day) {
          if (cached.metadataRevision !== synced.metadataRevision) {
            cached.report = relabelReport(cached.report, metadata);
            cached.metadataRevision = synced.metadataRevision;
          }
          report = restampReport(cached.report, at);
        } else {
          report = buildUsageStatsReport({
            serverInstanceId,
            spaceId: space.spaceId,
            query,
            observations,
            projects: projectInfo(projects),
            sessions: metadata,
            now: at,
          });
          state.reports.delete(key);
          state.reports.set(key, {
            revision: synced.revision,
            metadataRevision: synced.metadataRevision,
            members: metadata.size,
            visible: fingerprint,
            day,
            report,
          });
          while (state.reports.size > MAX_CACHED_REPORTS) state.reports.delete(state.reports.keys().next().value!);
        }
        return options.harnessLabel ? { ...report, harnesses: report.harnesses.map(labelHarness) } : report;
      })().finally(() => {
        if (requests.get(key) === request) requests.delete(key);
      });
      requests.set(key, request);
      return request;
    },
    async observations(space, from) {
      const visible = await options.source.visibleSessions?.(space);
      const synced = await syncSpace(space);
      return readable(synced, visible).observations.filter((observation) => observation.timestamp >= from);
    },
    invalidate(spaceId) {
      if (spaceId) spaces.delete(spaceId);
      else spaces.clear();
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const [spaceId, state] of spaces) {
        const space = contexts.get(spaceId);
        if (space) persist(space, state);
      }
    },
  };
}
