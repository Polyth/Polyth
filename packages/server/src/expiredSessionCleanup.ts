// Automatic cleanup of expired sessions, set per project in Settings →
// Projects → Cleanup. Each person chooses it for each project separately, in
// their synced client-settings record:
// `sessionDefaults.projectRetention[projectId] = { autoCleanup, days, action,
// skipIsolated, archiveDays }`. A private room follows its project's entry.
//
// It is off unless a person turned it on, and it decides per session whose
// choice applies, so one member's setting never reaches another member's chats.
//
// Before the choice moved to projects it was one global choice per person
// (`product.autoCleanupExpiredSessions` + `sessionDefaults.retentionDays` /
// `retentionAction` / `retentionSkipIsolated`). A project without an entry
// still follows that record, so nothing changes until the person edits a
// project; the client then writes an entry for every project and turns the
// global switch off.
//
// Archived sessions can go too: with `autoDeleteArchives` on, an archive older
// than that project's `archiveDays` is deleted permanently. Only a project's own
// entry turns it on (the older global record never had it).
//
// Isolated sessions are skipped until the same person says otherwise
// (`skipIsolated: false`). Then nothing of theirs stays: a delete takes the
// checkouts with the sessions, and an archive removes them while the sessions
// stay restorable on their target checkouts.
import type { QueueItemDto, SessionProjection } from "@polyth/contracts";
import {
  archivedSessionRetentionSummary,
  normalizedRetentionDays,
  sessionOwnsIsolatedCheckout,
  sessionRetentionSummary,
} from "@polyth/session";
import { accountsDecidingFor, type SessionAccountDeps } from "./failedStartupCleanup.ts";

/** Cleanup is routine housekeeping; an hour is fresh enough for a period counted in days. */
export const EXPIRED_SESSION_SWEEP_INTERVAL_MS = 60 * 60_000;
/** Boot recovery settles first, so the first pass judges sessions by real state. */
export const EXPIRED_SESSION_FIRST_SWEEP_DELAY_MS = 10 * 60_000;
/** A changed choice applies soon, with time to take back a slip of the finger. */
export const EXPIRED_SESSION_SETTINGS_SWEEP_DELAY_MS = 30_000;
/** Each archive or delete rereads a project's rows and may retire a runtime, and
 *  a first pass can have hundreds to do. Pacing leaves the server responsive. */
const EXPIRED_SESSION_PAUSE_MS = 100;

export interface ExpiredCleanupPreference {
  days: number;
  action: "archive" | "delete";
  skipIsolated: boolean;
}

type RetentionRecord = {
  autoCleanup?: unknown;
  retentionDays?: unknown;
  retentionAction?: unknown;
  retentionSkipIsolated?: unknown;
};
type SettingsRecord = {
  product?: { autoCleanupExpiredSessions?: unknown };
  sessionDefaults?: RetentionRecord & { projectRetention?: unknown };
} | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Only an explicit `true` turns this on. A missing period or action falls back
 *  to the Settings page's own defaults (30 days, archive). Only an explicit
 *  `false` lets it take isolated work: an older client's settings write drops
 *  fields it does not know, which must never widen what goes. */
function preferenceFrom(on: unknown, days: unknown, action: unknown, skipIsolated: unknown): ExpiredCleanupPreference | undefined {
  if (on !== true) return undefined;
  return {
    days: normalizedRetentionDays(typeof days === "number" ? days : 30),
    action: action === "delete" ? "delete" : "archive",
    skipIsolated: skipIsolated !== false,
  };
}

function legacyPreference(record: SettingsRecord): ExpiredCleanupPreference | undefined {
  return preferenceFrom(
    record?.product?.autoCleanupExpiredSessions,
    record?.sessionDefaults?.retentionDays,
    record?.sessionDefaults?.retentionAction,
    record?.sessionDefaults?.retentionSkipIsolated,
  );
}

function projectEntries(record: SettingsRecord): Record<string, unknown> {
  const map = record?.sessionDefaults?.projectRetention;
  return isRecord(map) ? map : {};
}

function entryPreference(entry: Record<string, unknown>): ExpiredCleanupPreference | undefined {
  return preferenceFrom(entry.autoCleanup, entry.days, entry.action, entry.skipIsolated);
}

/** One person's choice for one project (a room passes its project's id). A
 *  project with no entry of its own follows the older global choice. */
export function autoCleanupPreference(settings: unknown, projectId?: string): ExpiredCleanupPreference | undefined {
  const record = settings as SettingsRecord;
  const entries = projectEntries(record);
  if (projectId !== undefined && Object.hasOwn(entries, projectId)) {
    const entry = entries[projectId];
    return isRecord(entry) ? entryPreference(entry) : undefined;
  }
  return legacyPreference(record);
}

export interface ArchivePurgePreference {
  days: number;
  /** Archived trees still holding an isolated checkout stay unless `false`. */
  skipIsolated: boolean;
}

/** One person's "delete from the archive automatically" for one project. Only
 *  an explicit `true` in the project's own entry turns it on. */
export function archivePurgePreference(settings: unknown, projectId: string): ArchivePurgePreference | undefined {
  const entries = projectEntries(settings as SettingsRecord);
  if (!Object.hasOwn(entries, projectId)) return undefined;
  const entry = entries[projectId];
  if (!isRecord(entry) || entry.autoDeleteArchives !== true) return undefined;
  return {
    days: normalizedRetentionDays(typeof entry.archiveDays === "number" ? entry.archiveDays : 30),
    skipIsolated: entry.skipIsolated !== false,
  };
}

/** Every archive purge one person turned on, keyed by project. */
export function archivePurgeChoices(settings: unknown): Record<string, ArchivePurgePreference> {
  const choices: Record<string, ArchivePurgePreference> = {};
  for (const projectId of Object.keys(projectEntries(settings as SettingsRecord))) {
    const preference = archivePurgePreference(settings, projectId);
    if (preference) choices[projectId] = preference;
  }
  return choices;
}

/** Every choice one person made that turns cleanup on somewhere, keyed by
 *  project, with the older global choice under `*`. */
export function autoCleanupChoices(settings: unknown): Record<string, ExpiredCleanupPreference> {
  const record = settings as SettingsRecord;
  const choices: Record<string, ExpiredCleanupPreference> = {};
  const legacy = legacyPreference(record);
  if (legacy) choices["*"] = legacy;
  for (const [projectId, entry] of Object.entries(projectEntries(record))) {
    const preference = isRecord(entry) ? entryPreference(entry) : undefined;
    if (preference) choices[projectId] = preference;
  }
  return choices;
}

export interface ExpiredSessionPolicy {
  /** The shortest period anyone in the Space opted into; undefined when nobody did. */
  shortestDays(spaceId: string): number | undefined;
  /** What may happen to this session (tree). A session with no recorded account
   *  needs every member's consent, on the longest period and the gentlest terms
   *  among them; an unresolvable Space keeps the session. */
  forSession(projection: SessionProjection): Promise<ExpiredCleanupPreference | undefined>;
  /** The shortest archive period anyone in the Space opted into deleting after. */
  shortestArchiveDays?(spaceId: string): number | undefined;
  /** Whether this archived session (tree) may be deleted, on what terms. The
   *  same accounts decide as for {@link forSession}; every one must opt in. */
  forArchivedSession?(projection: SessionProjection): Promise<ArchivePurgePreference | undefined>;
}

export function createExpiredSessionPolicy(
  deps: SessionAccountDeps & {
    /** The project whose cleanup choice applies: a private room's parent
     *  project, otherwise the project itself. */
    settingsProjectOf?: (projectId: string) => string;
  },
): ExpiredSessionPolicy {
  return {
    shortestDays(spaceId) {
      const days = deps.members(spaceId).flatMap((userId) =>
        Object.values(autoCleanupChoices(deps.settingsFor(userId))).map((preference) => preference.days));
      return days.length > 0 ? Math.min(...days) : undefined;
    },
    shortestArchiveDays(spaceId) {
      const days = deps.members(spaceId).flatMap((userId) =>
        Object.values(archivePurgeChoices(deps.settingsFor(userId))).map((preference) => preference.days));
      return days.length > 0 ? Math.min(...days) : undefined;
    },
    async forArchivedSession(projection) {
      const accounts = await accountsDecidingFor(deps, projection);
      const projectId = deps.settingsProjectOf?.(projection.projectId) ?? projection.projectId;
      const preferences: ArchivePurgePreference[] = [];
      for (const userId of accounts) {
        const preference = archivePurgePreference(deps.settingsFor(userId), projectId);
        if (!preference) return undefined;
        preferences.push(preference);
      }
      if (preferences.length === 0) return undefined;
      return {
        days: Math.max(...preferences.map((preference) => preference.days)),
        skipIsolated: preferences.some((preference) => preference.skipIsolated),
      };
    },
    async forSession(projection) {
      const accounts = await accountsDecidingFor(deps, projection);
      const projectId = deps.settingsProjectOf?.(projection.projectId) ?? projection.projectId;
      const preferences: ExpiredCleanupPreference[] = [];
      for (const userId of accounts) {
        const preference = autoCleanupPreference(deps.settingsFor(userId), projectId);
        if (!preference) return undefined;
        preferences.push(preference);
      }
      if (preferences.length === 0) return undefined;
      return {
        days: Math.max(...preferences.map((preference) => preference.days)),
        action: preferences.every((preference) => preference.action === "delete") ? "delete" : "archive",
        skipIsolated: preferences.some((preference) => preference.skipIsolated),
      };
    },
  };
}

/** Sessions any of these people pinned or left a draft in. Those live per person,
 *  outside the shared rows the sweep lists. */
export function sessionsKeptByPeople(
  sessionIds: readonly string[],
  people: readonly string[],
  personStates: (sessionIds: readonly string[], personId: string) => Record<string, { pinned?: unknown; draft?: string }>,
): Set<string> {
  const kept = new Set<string>();
  for (const personId of people) {
    for (const [sessionId, state] of Object.entries(personStates(sessionIds, personId))) {
      if (state.pinned || state.draft?.trim()) kept.add(sessionId);
    }
  }
  return kept;
}

/** Removing anything nobody asked for right now needs certainty. An `unknown` or
 *  `epoch-pending` session may still be executing: it is only archived, which
 *  loses nothing, and any checkout it holds waits until it has been quiet in the
 *  archive for the whole period. */
function settledForUnattendedRemoval(session: SessionProjection): boolean {
  return session.status === "idle" || session.status === "failed" || session.status === "archived";
}

export interface ExpiredSessionSource {
  list(): Promise<SessionProjection[]>;
  snapshot(sessionId: string): Promise<SessionProjection>;
  archive(sessionId: string): Promise<void>;
  delete?(sessionId: string): Promise<void>;
  queueList?(sessionId: string): Promise<QueueItemDto[]>;
}

export interface ExpiredSweepResult {
  scanned: number;
  archived: string[];
  deleted: string[];
  /** Trees whose isolated checkouts were removed while the sessions stayed archived. */
  released: string[];
  /** Archived trees deleted because they sat in the archive past its period. */
  purged: string[];
  failed: Array<{ id: string; code: string }>;
}

/**
 * One pass over one Space. The topmost expired session of each tree is the unit:
 * its owner's choice decides, and the Space-scoped archive/delete takes the rest
 * of the tree with it. A failure keeps that session and moves on to the next.
 */
export async function sweepExpiredSessions(input: {
  sessions: ExpiredSessionSource;
  /** The host's removal of an archived tree's checkouts. Absent: isolated
   *  sessions are always skipped. */
  releaseCheckouts?: (sessionId: string) => Promise<void>;
  policy: Pick<ExpiredSessionPolicy, "forSession" | "forArchivedSession">;
  /** From {@link ExpiredSessionPolicy.shortestDays}. Undefined, with no archive
   *  period either, ends the pass before listing anything, so the feature
   *  costs nothing while it is off. */
  shortestDays: number | undefined;
  /** From {@link ExpiredSessionPolicy.shortestArchiveDays}. */
  shortestArchiveDays?: number | undefined;
  keep?: (sessionIds: readonly string[]) => ReadonlySet<string>;
  now?: () => number;
  pause?: () => Promise<void>;
  stopped?: () => boolean;
}): Promise<ExpiredSweepResult> {
  const result: ExpiredSweepResult = { scanned: 0, archived: [], deleted: [], released: [], purged: [], failed: [] };
  if (input.shortestDays === undefined && input.shortestArchiveDays === undefined) return result;
  const now = (input.now ?? Date.now)();
  const pause = input.pause ?? (() => new Promise<void>((resolve) => {
    setTimeout(resolve, EXPIRED_SESSION_PAUSE_MS).unref();
  }));
  const rows = await input.sessions.list();
  result.scanned = rows.length;
  const keep = input.keep?.(rows.map((row) => row.id));
  const expiredByTerms = new Map<string, ReadonlySet<string>>();
  const expiredAfter = (days: number, skipIsolated: boolean): ReadonlySet<string> => {
    const terms = `${days}:${skipIsolated}`;
    let expired = expiredByTerms.get(terms);
    if (!expired) {
      const summary = sessionRetentionSummary(rows, days, now, { ...(keep ? { keep } : {}), skipIsolated });
      expired = new Set([...summary.eligible, ...summary.checkouts].map((row) => row.id));
      expiredByTerms.set(terms, expired);
    }
    return expired;
  };
  // Every longer period's expired set sits inside the shortest period's, and
  // skipping isolated sessions only ever takes sessions out.
  const candidates = input.shortestDays === undefined
    ? new Set<string>()
    : expiredAfter(input.shortestDays, !input.releaseCheckouts);
  const childrenOf = new Map<string, SessionProjection[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    childrenOf.set(row.parentId, [...childrenOf.get(row.parentId) ?? [], row]);
  }
  // Archived members included: a delete cascades to them too.
  const treeOf = (top: SessionProjection): SessionProjection[] => {
    const tree: SessionProjection[] = [];
    const seen = new Set<string>();
    const stack = [top];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      tree.push(current);
      stack.push(...childrenOf.get(current.id) ?? []);
    }
    return tree;
  };

  for (const top of rows) {
    if (!candidates.has(top.id) || (top.parentId && candidates.has(top.parentId))) continue;
    if (input.stopped?.()) break;
    try {
      const preference = await input.policy.forSession(top);
      if (!preference) continue;
      const skipIsolated = preference.skipIsolated || !input.releaseCheckouts;
      if (!expiredAfter(preference.days, skipIsolated).has(top.id)) continue;
      const tree = treeOf(top);
      let queued = false;
      for (const member of tree) {
        // Queued delivery is durable intent to keep working in this session.
        if ((await input.sessions.queueList?.(member.id) ?? []).length > 0) { queued = true; break; }
      }
      if (queued) continue;
      // The pass can run for minutes, and the Space-scoped services take no
      // version fence. Anything that touched the session since the list wins.
      const fresh = await input.sessions.snapshot(top.id);
      if (fresh.status !== top.status || fresh.updatedAt !== top.updatedAt) continue;
      await pause();
      const settled = tree.every(settledForUnattendedRemoval);
      // An archived session's history is its Archive section's to delete.
      const alreadyArchived = top.status === "archived";
      if (preference.action === "delete" && input.sessions.delete && settled && !alreadyArchived) {
        await input.sessions.delete(top.id);
        result.deleted.push(top.id);
        continue;
      }
      // Idempotent when archived already, and it checks access to the whole tree.
      await input.sessions.archive(top.id);
      if (!alreadyArchived) result.archived.push(top.id);
      if (settled && !skipIsolated && tree.some(sessionOwnsIsolatedCheckout)) {
        await input.releaseCheckouts?.(top.id);
        result.released.push(top.id);
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      result.failed.push({ id: top.id, code: typeof code === "string" && code ? code : "internal" });
    }
  }
  if (input.shortestArchiveDays !== undefined && input.policy.forArchivedSession) {
    await purgeOldArchives(input, rows, keep, treeOf, now, pause, result);
  }
  return result;
}

/** Archived chats whose isolated checkouts hold no work lose them, whatever the
 *  person chose in Cleanup: nothing is lost, and the archive-time release skips a
 *  chat archived mid-turn, before this behavior, or whose release failed. The unit
 *  is each archived session whose parent is not archived; the host releases its
 *  archived subtree and keeps every checkout that holds work. */
export async function releaseEmptyArchivedCheckouts(input: {
  sessions: Pick<ExpiredSessionSource, "list">;
  releaseEmpty: (sessionId: string) => Promise<void>;
  stopped?: () => boolean;
  pause?: () => Promise<void>;
}): Promise<{ released: string[]; failed: Array<{ id: string; code: string }> }> {
  const result: { released: string[]; failed: Array<{ id: string; code: string }> } = { released: [], failed: [] };
  const rows = await input.sessions.list();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, SessionProjection[]>();
  for (const row of rows) {
    if (row.parentId) childrenOf.set(row.parentId, [...childrenOf.get(row.parentId) ?? [], row]);
  }
  const withCheckout = (top: SessionProjection): boolean => {
    const stack = [top];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      if (current.status === "archived" && sessionOwnsIsolatedCheckout(current)) return true;
      stack.push(...childrenOf.get(current.id) ?? []);
    }
    return false;
  };
  for (const top of rows) {
    if (top.status !== "archived") continue;
    const parent = top.parentId ? byId.get(top.parentId) : undefined;
    if (parent?.status === "archived") continue;
    if (!withCheckout(top)) continue;
    if (input.stopped?.()) break;
    try {
      await input.pause?.();
      await input.releaseEmpty(top.id);
      result.released.push(top.id);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      result.failed.push({ id: top.id, code: typeof code === "string" && code ? code : "internal" });
    }
  }
  return result;
}

/** Archives past their period go for good. The unit is the topmost archived
 *  session of each tree; deleting it takes the rest. A tree anyone pinned, left
 *  a draft in, queued delivery to or touched since the list stays. */
async function purgeOldArchives(
  input: Parameters<typeof sweepExpiredSessions>[0],
  rows: readonly SessionProjection[],
  keep: ReadonlySet<string> | undefined,
  treeOf: (top: SessionProjection) => SessionProjection[],
  now: number,
  pause: () => Promise<void>,
  result: ExpiredSweepResult,
): Promise<void> {
  if (!input.sessions.delete || input.shortestArchiveDays === undefined || !input.policy.forArchivedSession) return;
  const oldAfter = (days: number) => new Set(archivedSessionRetentionSummary(rows, days, now).eligible.map((row) => row.id));
  const candidates = oldAfter(input.shortestArchiveDays);
  const done = new Set([...result.archived, ...result.deleted]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const top of rows) {
    if (!candidates.has(top.id) || done.has(top.id)) continue;
    const parent = top.parentId ? byId.get(top.parentId) : undefined;
    if (parent?.status === "archived") continue;
    if (input.stopped?.()) break;
    try {
      const preference = await input.policy.forArchivedSession(top);
      if (!preference || !oldAfter(preference.days).has(top.id)) continue;
      const tree = treeOf(top);
      // Every member must itself be an old archive: a live child keeps the tree.
      if (!tree.every((member) => member.status === "archived" && candidates.has(member.id))) continue;
      if (tree.some((member) => keep?.has(member.id))) continue;
      if (preference.skipIsolated && tree.some(sessionOwnsIsolatedCheckout)) continue;
      let queued = false;
      for (const member of tree) {
        if ((await input.sessions.queueList?.(member.id) ?? []).length > 0) { queued = true; break; }
      }
      if (queued) continue;
      const fresh = await input.sessions.snapshot(top.id);
      if (fresh.status !== "archived" || fresh.updatedAt !== top.updatedAt) continue;
      await pause();
      await input.sessions.delete(top.id);
      result.purged.push(top.id);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      result.failed.push({ id: top.id, code: typeof code === "string" && code ? code : "internal" });
    }
  }
}

export interface ExpiredSessionCleanup {
  /** Tell the sweep an account's settings changed; a changed choice runs soon. */
  settingsChanged(userId: string, settings: unknown): void;
  /** Stop scheduling and wait for a pass in flight. */
  stop(): Promise<void>;
}

/** Owns the schedule: one pass at a time, over each Space in turn. */
export function startExpiredSessionCleanup(deps: {
  spaceIds(): readonly string[];
  sessionsFor(spaceId: string): ExpiredSessionSource;
  releaseCheckouts?: (sessionId: string) => Promise<void>;
  /** Release the empty checkouts of an archived tree ({@link releaseEmptyArchivedCheckouts}). */
  releaseEmptyCheckouts?: (sessionId: string) => Promise<void>;
  policy: ExpiredSessionPolicy;
  keep(spaceId: string, sessionIds: readonly string[]): ReadonlySet<string>;
  stopped(): boolean;
  firstDelayMs?: number;
  intervalMs?: number;
  settingsDelayMs?: number;
  pause?: () => Promise<void>;
}): ExpiredSessionCleanup {
  let flight: Promise<void> | undefined;
  let ended = false;
  const run = (): Promise<void> => {
    if (ended || deps.stopped()) return Promise.resolve();
    flight ??= (async () => {
      for (const spaceId of deps.spaceIds()) {
        if (ended || deps.stopped()) return;
        try {
          const result = await sweepExpiredSessions({
            sessions: deps.sessionsFor(spaceId),
            ...(deps.releaseCheckouts ? { releaseCheckouts: deps.releaseCheckouts } : {}),
            policy: deps.policy,
            shortestDays: deps.policy.shortestDays(spaceId),
            shortestArchiveDays: deps.policy.shortestArchiveDays?.(spaceId),
            keep: (ids) => deps.keep(spaceId, ids),
            stopped: () => ended || deps.stopped(),
            ...(deps.pause ? { pause: deps.pause } : {}),
          });
          if (result.archived.length > 0 || result.deleted.length > 0 || result.released.length > 0 || result.purged.length > 0) {
            console.log(`[polyth] expired session cleanup archived ${result.archived.length} and deleted ${result.deleted.length} session(s), removed the isolated checkouts of ${result.released.length} tree(s) and deleted ${result.purged.length} old archive(s) in space ${spaceId}`);
          }
          for (const failure of result.failed) {
            console.warn(`[polyth] expired session cleanup kept ${failure.id} (${failure.code})`);
          }
        } catch (error) {
          // Housekeeping must never take the server with it.
          console.warn(`[polyth] expired session cleanup failed for space ${spaceId}`, error);
        }
        if (!deps.releaseEmptyCheckouts) continue;
        try {
          const empty = await releaseEmptyArchivedCheckouts({
            sessions: deps.sessionsFor(spaceId),
            releaseEmpty: deps.releaseEmptyCheckouts,
            stopped: () => ended || deps.stopped(),
            ...(deps.pause ? { pause: deps.pause } : {}),
          });
          for (const failure of empty.failed) {
            console.warn(`[polyth] archived empty checkout release kept ${failure.id} (${failure.code})`);
          }
        } catch (error) {
          console.warn(`[polyth] archived empty checkout release failed for space ${spaceId}`, error);
        }
      }
    })().finally(() => { flight = undefined; });
    return flight;
  };

  const firstTimer = setTimeout(() => { void run(); }, deps.firstDelayMs ?? EXPIRED_SESSION_FIRST_SWEEP_DELAY_MS);
  firstTimer.unref();
  const intervalTimer = setInterval(() => { void run(); }, deps.intervalMs ?? EXPIRED_SESSION_SWEEP_INTERVAL_MS);
  intervalTimer.unref();
  let soonTimer: NodeJS.Timeout | undefined;
  const lastChoice = new Map<string, string>();

  return {
    settingsChanged(userId, settings) {
      const choices = autoCleanupChoices(settings);
      const purges = archivePurgeChoices(settings);
      const choice = JSON.stringify({ choices, purges });
      if (lastChoice.get(userId) === choice) return;
      lastChoice.set(userId, choice);
      if ((Object.keys(choices).length === 0 && Object.keys(purges).length === 0) || ended) return;
      if (soonTimer) clearTimeout(soonTimer);
      soonTimer = setTimeout(() => { void run(); }, deps.settingsDelayMs ?? EXPIRED_SESSION_SETTINGS_SWEEP_DELAY_MS);
      soonTimer.unref();
    },
    async stop() {
      ended = true;
      clearTimeout(firstTimer);
      clearInterval(intervalTimer);
      if (soonTimer) clearTimeout(soonTimer);
      await flight;
    },
  };
}
