// Server-side reader for the web "Delete failed startup sessions" choice
// (`product.autoDeleteFailedStartupSessions` in the synced client-settings
// record). Every server path that would delete a failed, uncertain or
// never-prompted session asks this policy first, so the user's choice is
// authoritative whether the deletion is driven by a browser, the delegated
// child settlement or the pristine-session sweep.
import type { SessionProjection } from "@polyth/contracts";

/** Mirrors the web default (`DEFAULT_SETTINGS.autoDeleteFailedStartupSessions`):
 * only an explicit `false` opts out. */
export function autoDeleteFailedStartupPreference(settings: unknown): boolean {
  const product = (settings as { product?: { autoDeleteFailedStartupSessions?: unknown } } | null | undefined)?.product;
  return product?.autoDeleteFailedStartupSessions !== false;
}

export type FailedStartupCleanupPolicy = (projection: SessionProjection) => Promise<boolean>;

export interface FailedStartupCleanupPolicyDeps {
  /** The Space a session belongs to (projection.spaceId or its project's Space). */
  spaceOf(projection: SessionProjection): string | undefined | Promise<string | undefined>;
  /** The account a session reports to inside that Space, if one was recorded. */
  accountForSession(sessionId: string, spaceId: string): Promise<string | undefined>;
  /** Every account with a role in the Space. */
  members(spaceId: string): readonly string[];
  /** That account's synced client-settings object. */
  settingsFor(userId: string): unknown;
  /** Session lookup for walking a delegated child up to its root. */
  projection(sessionId: string): Promise<SessionProjection | undefined>;
}

const MAX_PARENT_DEPTH = 16;

/** Deletion is allowed only when the owning account's preference allows it.
 * A session with no recorded account (and no recorded ancestor) falls back to
 * the Space's members: any member who chose to keep failed sessions wins, and
 * an unresolvable Space keeps the session. Keeping is never destructive. */
export function createFailedStartupCleanupPolicy(deps: FailedStartupCleanupPolicyDeps): FailedStartupCleanupPolicy {
  return async (projection) => {
    const spaceId = await deps.spaceOf(projection);
    if (!spaceId) return false;
    let current: SessionProjection | undefined = projection;
    const seen = new Set<string>();
    for (let depth = 0; current && depth < MAX_PARENT_DEPTH && !seen.has(current.id); depth++) {
      seen.add(current.id);
      const userId = await deps.accountForSession(current.id, spaceId);
      if (userId) return autoDeleteFailedStartupPreference(deps.settingsFor(userId));
      current = current.parentId ? await deps.projection(current.parentId) : undefined;
    }
    const members = deps.members(spaceId);
    return members.length > 0
      && members.every((userId) => autoDeleteFailedStartupPreference(deps.settingsFor(userId)));
  };
}
