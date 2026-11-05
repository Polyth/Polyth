import type { SessionEvent, SessionProjection } from "@polyth/contracts";

/**
 * Event types a session that was created but never used can contain. Anything
 * outside this closed set — a prompt, tool/browser/terminal/package activity,
 * a queue admission, a fork/import — proves the session holds real work.
 */
const PRISTINE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session/created",
  "mutation/prepared",
  "mutation/claimed",
  "mutation/confirmed",
  "mutation/rejected",
  "mutation/uncertainty-recorded",
  "mutation/nonapplication-confirmed",
  "reconciliation/started",
  "reconciliation/completed",
  "reconciliation/blocked",
  "runtime/status-observed",
]);

/**
 * True when the canonical log contains nothing but the create/reconcile
 * lifecycle. The check is deliberately fail-closed: an unknown event type, or
 * any mutation other than the session creation itself, means the session is
 * not disposable. A pristine session is safe to delete or to reattach without
 * native evidence because it can never have admitted a turn.
 */
export function isPristineSessionLog(
  events: readonly Pick<SessionEvent, "type" | "data">[],
): boolean {
  if (!events.some((event) => event.type === "session/created")) return false;
  return events.every((event) => {
    if (!PRISTINE_SESSION_EVENT_TYPES.has(event.type)) return false;
    if (!event.type.startsWith("mutation/")) return true;
    return (event.data as { mutationKind?: unknown }).mutationKind === "session-create";
  });
}

export interface SessionRetentionSummary {
  days: number;
  cutoff: number;
  eligible: SessionProjection[];
}

export function normalizedRetentionDays(days: number): number {
  return Number.isFinite(days)
    ? Math.min(3650, Math.max(1, Math.round(days)))
    : 30;
}

/** A person or a package still expects to come back to this session, however
 *  long it has been quiet. Age alone must never take it away. */
function sessionStillInUse(session: SessionProjection): boolean {
  const background = session.backgroundWork;
  return session.status === "working"
    || session.status === "waiting"
    || Boolean(session.pinned)
    || Boolean(session.draft?.trim() || session.draftPreview)
    || Boolean(session.resume)
    || Boolean(session.paused)
    || Boolean(session.attention?.questions || session.attention?.permissions)
    || Boolean(background?.multirun || background?.fusion || background?.workflow);
}

/**
 * Sessions the Cleanup settings may take away, for the button and the automatic
 * sweep alike, so the count on screen is what either of them acts on.
 *
 * A delegation tree expires whole: Space-scoped archive and delete cascade down
 * a tree, so one recent or still-used member keeps every member, and an old
 * parent can never take a running child with it. An archived member is already
 * cleaned up and holds nothing back. A tree rooted in a package-owned session
 * (`purpose`) follows that package's lifecycle: the Agents page, for one, cannot
 * continue a thread once its session is archived.
 *
 * `keep` adds sessions the rows cannot show, such as another person's pin.
 */
export function sessionRetentionSummary(
  sessions: readonly SessionProjection[],
  days: number,
  now = Date.now(),
  keep?: ReadonlySet<string>,
): SessionRetentionSummary {
  const normalized = normalizedRetentionDays(days);
  const cutoff = now - normalized * 24 * 60 * 60_000;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rootOf = (session: SessionProjection): SessionProjection => {
    const seen = new Set([session.id]);
    let current = session;
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const heldTrees = new Set<string>();
  for (const session of sessions) {
    const root = rootOf(session);
    if (root.purpose) heldTrees.add(root.id);
    if (session.status === "archived") continue;
    if (session.updatedAt > cutoff || sessionStillInUse(session) || keep?.has(session.id)) {
      heldTrees.add(root.id);
    }
  }
  const eligible = sessions.filter((session) =>
    session.status !== "archived" && !heldTrees.has(rootOf(session).id));
  return { days: normalized, cutoff, eligible };
}

/** Archived sessions become purge candidates based on their archive timestamp. */
export function archivedSessionRetentionSummary(
  sessions: readonly SessionProjection[],
  days: number,
  now = Date.now(),
): SessionRetentionSummary {
  const normalized = normalizedRetentionDays(days);
  const cutoff = now - normalized * 24 * 60 * 60_000;
  const eligible = sessions.filter((session) =>
    session.status === "archived" && session.updatedAt <= cutoff);
  return { days: normalized, cutoff, eligible };
}
