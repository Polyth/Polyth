// "Clean up automatically" in Settings → Sessions: expired sessions go without
// anyone pressing the button. The choice is `product.autoCleanupExpiredSessions`
// in the synced client-settings record, read with the period and action the same
// person set beside it (`sessionDefaults.retentionDays` / `retentionAction`).
//
// It is off unless a person turned it on, and it decides per session whose
// choice applies, so one member's setting never reaches another member's chats.
//
// Isolated sessions are skipped until the same person says otherwise
// (`sessionDefaults.retentionSkipIsolated: false`). Then nothing of theirs stays:
// a delete takes the checkouts with the sessions, and an archive removes them
// while the sessions stay restorable on their target checkouts.
import type { QueueItemDto, SessionProjection } from "@polyth/contracts";
import { normalizedRetentionDays, sessionOwnsIsolatedCheckout, sessionRetentionSummary } from "@polyth/session";
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

/** Only an explicit `true` turns this on. A missing period or action falls back
 *  to the Settings page's own defaults (30 days, archive). Only an explicit
 *  `false` lets it take isolated work: an older client's settings write drops
 *  fields it does not know, which must never widen what goes. */
export function autoCleanupPreference(settings: unknown): ExpiredCleanupPreference | undefined {
  const record = settings as {
    product?: { autoCleanupExpiredSessions?: unknown };
    sessionDefaults?: { retentionDays?: unknown; retentionAction?: unknown; retentionSkipIsolated?: unknown };
  } | null | undefined;
  if (record?.product?.autoCleanupExpiredSessions !== true) return undefined;
  const days = record.sessionDefaults?.retentionDays;
  return {
    days: normalizedRetentionDays(typeof days === "number" ? days : 30),
    action: record.sessionDefaults?.retentionAction === "delete" ? "delete" : "archive",
    skipIsolated: record.sessionDefaults?.retentionSkipIsolated !== false,
  };
}

export interface ExpiredSessionPolicy {
  /** The shortest period anyone in the Space opted into; undefined when nobody did. */
  shortestDays(spaceId: string): number | undefined;
  /** What may happen to this session (tree). A session with no recorded account
   *  needs every member's consent, on the longest period and the gentlest terms
   *  among them; an unresolvable Space keeps the session. */
  forSession(projection: SessionProjection): Promise<ExpiredCleanupPreference | undefined>;
}

export function createExpiredSessionPolicy(deps: SessionAccountDeps): ExpiredSessionPolicy {
  return {
    shortestDays(spaceId) {
      const days = deps.members(spaceId).flatMap((userId) => {
        const preference = autoCleanupPreference(deps.settingsFor(userId));
        return preference ? [preference.days] : [];
      });
      return days.length > 0 ? Math.min(...days) : undefined;
    },
    async forSession(projection) {
      const accounts = await accountsDecidingFor(deps, projection);
      const preferences: ExpiredCleanupPreference[] = [];
      for (const userId of accounts) {
        const preference = autoCleanupPreference(deps.settingsFor(userId));
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
  policy: Pick<ExpiredSessionPolicy, "forSession">;
  /** From {@link ExpiredSessionPolicy.shortestDays}. Undefined ends the pass
   *  before listing anything, so the feature costs nothing while it is off. */
  shortestDays: number | undefined;
  keep?: (sessionIds: readonly string[]) => ReadonlySet<string>;
  now?: () => number;
  pause?: () => Promise<void>;
  stopped?: () => boolean;
}): Promise<ExpiredSweepResult> {
  const result: ExpiredSweepResult = { scanned: 0, archived: [], deleted: [], released: [], failed: [] };
  if (input.shortestDays === undefined) return result;
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
  const candidates = expiredAfter(input.shortestDays, !input.releaseCheckouts);
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
  return result;
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
            keep: (ids) => deps.keep(spaceId, ids),
            stopped: () => ended || deps.stopped(),
            ...(deps.pause ? { pause: deps.pause } : {}),
          });
          if (result.archived.length > 0 || result.deleted.length > 0 || result.released.length > 0) {
            console.log(`[polyth] expired session cleanup archived ${result.archived.length} and deleted ${result.deleted.length} session(s) and removed the isolated checkouts of ${result.released.length} tree(s) in space ${spaceId}`);
          }
          for (const failure of result.failed) {
            console.warn(`[polyth] expired session cleanup kept ${failure.id} (${failure.code})`);
          }
        } catch (error) {
          // Housekeeping must never take the server with it.
          console.warn(`[polyth] expired session cleanup failed for space ${spaceId}`, error);
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
      const preference = autoCleanupPreference(settings);
      const choice = JSON.stringify(preference ?? null);
      if (lastChoice.get(userId) === choice) return;
      lastChoice.set(userId, choice);
      if (!preference || ended) return;
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
