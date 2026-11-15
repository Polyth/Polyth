import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteSync } from "@polyth/plugins";
import type {
  Project,
  SessionEvent,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import {
  createUsageReportBuild,
  createUsageSessionRollup,
  type UsageSessionMetadata,
  type UsageSessionRollup,
} from "./aggregate.ts";
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
  /**
   * The newest event seq of every session in the Space (or one project) in a
   * single read. Preferred over `latestSeq`: a report otherwise asks once per
   * session, which is the whole cost of opening Usage on a large Space.
   * Resolves undefined when the store cannot answer it.
   */
  latestSeqs?(space: SpaceContext, scope?: { projectId?: string }): Promise<ReadonlyMap<string, number> | undefined>;
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
  /** The checkpoint file this session is written to. */
  shard: number;
  /** Built on the first report that reads the session, dropped with it. */
  rollup?: UsageSessionRollup;
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
  /** Checkpoint files whose sessions changed since they were written. */
  dirtyShards: Set<number>;
  /** The single-file checkpoint of older versions is still on disk. */
  legacy: boolean;
  /** Bumped whenever a session's observations change (added, removed, re-collected). */
  revision: number;
  /** Bumped when only a session's title or status changed. A built report stays
   * valid across these: its session rows are relabelled instead of rebuilt. */
  metadataRevision: number;
  /** Built reports by exact query, valid while `revision` holds. */
  reports: Map<string, CachedReport>;
}

/** The checkpoint is a cold-start cache, written a while after a change. */
const PERSIST_DELAY_MS = 10_000;
/**
 * The checkpoint is split by session id into this many files. One file held a
 * large Space's whole history (over 100 MB): every write serialized all of it
 * and stopped the server for more than a second, every ten seconds of work.
 * Now a change rewrites the file of the session that changed.
 */
const CHECKPOINT_SHARDS = 64;

const shardOf = (sessionId: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = Math.imul(hash ^ sessionId.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) % CHECKPOINT_SHARDS;
};

const yieldToLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const MAX_CACHED_REPORTS = 32;
/** A range nobody opened yet is prepared in slices this long, yielding between them. */
const BUILD_SLICE_MS = 12;

const rollupOf = (id: string, session: SessionState): UsageSessionRollup =>
  session.rollup ??= createUsageSessionRollup(id, session.observations);

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
  /** The sessions in scope, as they were when this materialization finished. */
  sessions: Map<string, SessionState>;
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

/** Sessions of one checkpoint file; a damaged or foreign file yields none. */
const parseCheckpoint = (text: string, spaceId: string, version: 1 | 2): SessionState[] => {
  const result: SessionState[] = [];
  try {
    const raw = JSON.parse(text) as {
      version?: unknown;
      spaceId?: unknown;
      sessions?: unknown;
    };
    if (raw.version !== version || raw.spaceId !== spaceId || !Array.isArray(raw.sessions)) return result;
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
      result.push({
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
        shard: shardOf(row.id),
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

  const loading = new Map<string, Promise<SpaceState>>();

  const pathsFor = (space: SpaceContext): { legacy: string; shards: string } | undefined => {
    const directory = options.storageDir?.(space);
    return directory ? { legacy: `${directory}/analytics-v1.json`, shards: `${directory}/analytics-v2` } : undefined;
  };
  const shardFile = (directory: string, shard: number): string =>
    `${directory}/${shard.toString(16).padStart(2, "0")}.json`;

  const loadState = async (space: SpaceContext): Promise<SpaceState> => {
    const state: SpaceState = {
      sessions: new Map(),
      lastSyncAt: 0,
      dirtyShards: new Set(),
      legacy: false,
      revision: 0,
      metadataRevision: 0,
      reports: new Map(),
    };
    const paths = pathsFor(space);
    if (!paths) return state;
    const written = new Set<number>();
    for (let shard = 0; shard < CHECKPOINT_SHARDS; shard += 1) {
      let text: string;
      try {
        text = await readFile(shardFile(paths.shards, shard), "utf8");
      } catch {
        continue;
      }
      written.add(shard);
      for (const session of parseCheckpoint(text, space.spaceId, 2)) state.sessions.set(session.metadata.id, session);
      // Parsing is the synchronous part: let other requests run between files.
      await yieldToLoop();
    }
    let legacy: string | undefined;
    try {
      legacy = await readFile(paths.legacy, "utf8");
    } catch {
      legacy = undefined;
    }
    if (legacy !== undefined) {
      // Move the old single file over once. A shard already written holds newer
      // state than the old file, also after an interrupted move.
      state.legacy = true;
      for (const session of parseCheckpoint(legacy, space.spaceId, 1)) {
        if (written.has(session.shard)) continue;
        state.sessions.set(session.metadata.id, session);
        state.dirtyShards.add(session.shard);
      }
    }
    return state;
  };

  const stateFor = (space: SpaceContext): Promise<SpaceState> => {
    const existing = spaces.get(space.spaceId);
    if (existing) return Promise.resolve(existing);
    const pending = loading.get(space.spaceId);
    if (pending) return pending;
    const load: Promise<SpaceState> = loadState(space).then((state) => {
      // Invalidated while it was being read: read it again.
      if (loading.get(space.spaceId) !== load) return stateFor(space);
      loading.delete(space.spaceId);
      spaces.set(space.spaceId, state);
      contexts.set(space.spaceId, space);
      if (state.legacy) schedulePersist(space, state);
      return state;
    });
    loading.set(space.spaceId, load);
    return load;
  };

  const writeShard = (space: SpaceContext, state: SpaceState, shard: number): boolean => {
    const paths = pathsFor(space);
    if (!paths) return false;
    try {
      mkdirSync(paths.shards, { recursive: true });
      const sessions: unknown[] = [];
      for (const [id, session] of state.sessions) {
        if (session.shard !== shard) continue;
        sessions.push({
          id,
          title: session.metadata.title,
          status: session.metadata.status,
          fingerprint: session.fingerprint,
          seq: session.seq,
          observations: session.observations,
        });
      }
      atomicWriteSync(shardFile(paths.shards, shard), JSON.stringify({ version: 2, spaceId: space.spaceId, sessions }));
      state.dirtyShards.delete(shard);
      return true;
    } catch {
      // Analytics remains available from the in-memory index; persistence is a
      // performance optimization and never a reason to blank the report.
      return false;
    }
  };

  /** Once every session it held is in a shard, the old single file can go. */
  const dropLegacy = (space: SpaceContext, state: SpaceState): void => {
    const paths = pathsFor(space);
    if (!paths || !state.legacy || state.dirtyShards.size > 0) return;
    try {
      rmSync(paths.legacy, { force: true });
      state.legacy = false;
    } catch { /* retried with the next write */ }
  };

  /** Shutdown: write everything that changed now. */
  const persist = (space: SpaceContext, state: SpaceState): void => {
    for (const shard of [...state.dirtyShards]) {
      if (!writeShard(space, state, shard)) return;
    }
    dropLegacy(space, state);
  };

  /** One file per event-loop turn, so a large backlog never stalls the server. */
  const persistStep = (space: SpaceContext, state: SpaceState): void => {
    timers.delete(space.spaceId);
    if (spaces.get(space.spaceId) !== state) return;
    const shard = state.dirtyShards.values().next().value;
    // A failed write waits for the next sync to schedule it again.
    if (shard !== undefined && !writeShard(space, state, shard)) return;
    if (state.dirtyShards.size > 0) arm(space, state, 0);
    else dropLegacy(space, state);
  };

  const arm = (space: SpaceContext, state: SpaceState, delay: number): void => {
    const timer = setTimeout(() => persistStep(space, state), delay);
    timer.unref?.();
    timers.set(space.spaceId, timer);
  };

  const schedulePersist = (space: SpaceContext, state: SpaceState): void => {
    // A pending write is left alone: re-arming it on every sync kept a busy
    // Space from ever writing its checkpoint.
    if (!pathsFor(space) || timers.has(space.spaceId)) return;
    arm(space, state, PERSIST_DELAY_MS);
  };

  const syncSpaceUnlocked = async (
    space: SpaceContext,
    scope?: UsageSyncScope,
  ): Promise<SyncedScope> => {
    const state = await stateFor(space);
    const listed = await options.source.projections(space, scope);
    const projections = scope?.sessionIds
      ? listed.filter((projection) => scope.sessionIds!.has(projection.id))
      : listed;
    const authoritativeListing = scope === undefined;
    const currentIds = new Set<string>();
    const changed: SessionProjection[] = [];
    // One read for every tail; a session scope is a handful of ids and keeps
    // the per-session check.
    const tails = options.source.latestSeqs && !scope?.sessionIds
      ? await options.source.latestSeqs(space, scope?.projectId ? { projectId: scope.projectId } : undefined)
      : undefined;
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
          state.dirtyShards.add(previous.shard);
        }
        if (!previous || previous.fingerprint !== fingerprint) {
          changed.push(projection);
        } else {
          // Check durable tails even when projection side effects lag behind.
          const latest = tails
            ? tails.get(projection.id) ?? previous.seq
            : options.source.latestSeq ? await options.source.latestSeq(space, projection.id) : previous.seq;
          if (latest > previous.seq) changed.push(projection);
          const metadata = { id: projection.id, title: projection.title, status: projection.status };
          if (previous.metadata.title !== metadata.title || previous.metadata.status !== metadata.status) {
            state.dirtyShards.add(previous.shard);
            state.metadataRevision += 1;
          }
          previous.metadata = metadata;
        }
      }
    };
    await runWorkers(projections.length, inspectProjection);
    const forget = (id: string): void => {
      const session = state.sessions.get(id);
      if (!session) return;
      state.sessions.delete(id);
      state.dirtyShards.add(session.shard);
      state.revision += 1;
    };
    if (authoritativeListing) {
      for (const id of [...state.sessions.keys()]) {
        if (!currentIds.has(id)) forget(id);
      }
    } else if (scope?.sessionIds) {
      for (const id of scope.sessionIds) {
        if (!currentIds.has(id)) forget(id);
      }
    } else if (scope?.projectId) {
      for (const [id, session] of [...state.sessions.entries()]) {
        const belongsToProject = session.observations.some((observation) =>
          observation.projectId === scope.projectId);
        if (belongsToProject && !currentIds.has(id)) forget(id);
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
          shard: shardOf(projection.id),
        });
        state.dirtyShards.add(shardOf(projection.id));
        state.revision += 1;
      }
    };
    await runWorkers(changed.length, worker);
    state.lastSyncAt = now();
    // A small scoped report must not copy the entire warm Space index.
    const metadata = new Map<string, UsageSessionMetadata>();
    const sessions = new Map<string, SessionState>();
    for (const id of currentIds) {
      const session = state.sessions.get(id);
      if (!session) continue;
      metadata.set(id, session.metadata);
      sessions.set(id, session);
    }
    if (state.dirtyShards.size > 0) schedulePersist(space, state);
    return { state, revision: state.revision, metadataRevision: state.metadataRevision, metadata, sessions };
  };

  /** The part of a materialization one reader may see. */
  const readable = (synced: SyncedScope, visible: ReadonlySet<string> | undefined) => {
    if (!visible) return { metadata: synced.metadata, sessions: synced.sessions, fingerprint: "" };
    const metadata = new Map([...synced.metadata].filter(([id]) => visible.has(id)));
    const sessions = new Map([...synced.sessions].filter(([id]) => visible.has(id)));
    const fingerprint = createHash("sha256").update([...metadata.keys()].sort().join("\n")).digest("hex");
    return { metadata, sessions, fingerprint };
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
          void stateFor(space).catch(() => undefined); // the report request reads it itself
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
        const { metadata, sessions, fingerprint } = readable(synced, visible);
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
          const rollups: UsageSessionRollup[] = [];
          for (const [id, session] of sessions) rollups.push(rollupOf(id, session));
          const build = createUsageReportBuild({
            serverInstanceId,
            spaceId: space.spaceId,
            query,
            rollups,
            projects: projectInfo(projects),
            sessions: metadata,
            now: at,
          });
          // Sessions unchanged since the last report for this range keep their
          // share, so only a range nobody opened yet has real work. Spread that
          // over event-loop turns: the server keeps answering everyone else.
          for (let sliceEnd = performance.now() + BUILD_SLICE_MS; !build.warm(() => performance.now() > sliceEnd);) {
            await new Promise<void>((resolve) => { setImmediate(resolve); });
            sliceEnd = performance.now() + BUILD_SLICE_MS;
          }
          report = build.finish();
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
      const observations: UsageObservation[] = [];
      for (const session of readable(synced, visible).sessions.values()) {
        for (const observation of session.observations) {
          if (observation.timestamp >= from) observations.push(observation);
        }
      }
      return observations;
    },
    invalidate(spaceId) {
      // A write scheduled for the dropped index must not hold the slot of the next one.
      for (const [id, timer] of timers) {
        if (spaceId && id !== spaceId) continue;
        clearTimeout(timer);
        timers.delete(id);
      }
      if (spaceId) {
        spaces.delete(spaceId);
        loading.delete(spaceId);
      } else {
        spaces.clear();
        loading.clear();
      }
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
