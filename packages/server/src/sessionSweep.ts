import type { QueueItemDto, SessionEvent, SessionProjection } from "@polyth/contracts";
import { isPristineSessionLog } from "@polyth/session";

/** A session that never held a prompt is disposable after this grace period.
 *  The window protects a draft the client has not finished syncing. */
export const PRISTINE_SESSION_GRACE_MS = 60 * 60_000;

/** Background cadence for pristine sessions created after boot. */
export const PRISTINE_SESSION_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface PristineSweepResult {
  scanned: number;
  eligible: number;
  deleted: string[];
  failed: Array<{ id: string; code: string }>;
}

/** The narrow scoped-session surface the sweep needs. `SessionService`
 *  satisfies it structurally. */
export interface PristineSessionSource {
  list(): Promise<SessionProjection[]>;
  events(sessionId: string): Promise<SessionEvent[]>;
  queueList?(sessionId: string): Promise<QueueItemDto[]>;
  delete?(sessionId: string, options?: { expectedLastEventSeq?: number; expectedUpdatedAt?: number }): Promise<void>;
}

/**
 * Delete sessions whose canonical log never admitted a turn: create/reconcile
 * lifecycle only, no draft, no queued delivery, no child. Such a session holds
 * no user content and no native work, so an abandoned one is garbage that must
 * not accumulate as a blank `unknown` sidebar row. The owner can opt out with
 * "Delete failed startup sessions" (`allowDelete`).
 *
 * Delegated children are excluded: their lifecycle belongs to the parent's
 * settlement path (`settleDelegatedChild`), which publishes removal to already
 * open clients. This sweep never guesses at that ownership.
 */
export async function sweepPristineSessions(input: {
  sessions: PristineSessionSource;
  now?: () => number;
  graceMs?: number;
  /** The owning account's "Delete failed startup sessions" choice. A pristine
   *  failed/unknown row is a failed startup; `false` keeps it. Omitted means
   *  allowed. */
  allowDelete?: (projection: SessionProjection) => boolean | Promise<boolean>;
}): Promise<PristineSweepResult> {
  const now = input.now ?? Date.now;
  const graceMs = input.graceMs ?? PRISTINE_SESSION_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new RangeError("pristine session grace must be a non-negative finite number");
  }
  const result: PristineSweepResult = { scanned: 0, eligible: 0, deleted: [], failed: [] };
  const remove = input.sessions.delete;
  if (!remove) return result;
  const rows = await input.sessions.list();
  const hasChildren = new Set(rows.map((row) => row.parentId).filter((id): id is string => !!id));
  const cutoff = now() - graceMs;
  for (const projection of rows) {
    result.scanned += 1;
    // Successful idle sessions may be intentionally empty. Only failed or
    // uncertain startup remnants are garbage; never make age alone destructive.
    if (projection.status !== "failed" && projection.status !== "unknown") continue;
    // A pristine parent can still be referenced by a delegated child.
    if (projection.parentId || hasChildren.has(projection.id)) continue;
    // A blank session may still own a user-requested checkout or a package
    // lifecycle. Those require their explicit owner/confirmation path.
    if (
      projection.purpose
      || projection.worktreePath
      || projection.isolation
      || projection.workspace?.repositories.some((repository) => repository.isolation)
    ) continue;
    if (projection.draft?.trim()) continue;
    if (projection.createdAt > cutoff) continue;
    try {
      if (input.allowDelete && !(await input.allowDelete(projection))) continue;
      if ((await input.sessions.queueList?.(projection.id) ?? []).length > 0) continue;
      const events = await input.sessions.events(projection.id);
      if (!isPristineSessionLog(events)) continue;
      result.eligible += 1;
      await remove(projection.id, {
        expectedLastEventSeq: events.at(-1)?.seq ?? 0,
        expectedUpdatedAt: projection.updatedAt,
      });
      result.deleted.push(projection.id);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      result.failed.push({
        id: projection.id,
        code: typeof code === "string" && code ? code : "internal",
      });
    }
  }
  return result;
}
