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

function normalizedDays(days: number): number {
  return Number.isFinite(days)
    ? Math.min(3650, Math.max(1, Math.round(days)))
    : 30;
}

/** Archived, working, and waiting sessions are never cleanup candidates. */
export function sessionRetentionSummary(
  sessions: readonly SessionProjection[],
  days: number,
  now = Date.now(),
): SessionRetentionSummary {
  const normalized = normalizedDays(days);
  const cutoff = now - normalized * 24 * 60 * 60_000;
  const eligible = sessions.filter((session) =>
    session.status !== "archived"
    && session.status !== "working"
    && session.status !== "waiting"
    && session.updatedAt <= cutoff);
  return { days: normalized, cutoff, eligible };
}

/** Archived sessions become purge candidates based on their archive timestamp. */
export function archivedSessionRetentionSummary(
  sessions: readonly SessionProjection[],
  days: number,
  now = Date.now(),
): SessionRetentionSummary {
  const normalized = normalizedDays(days);
  const cutoff = now - normalized * 24 * 60 * 60_000;
  const eligible = sessions.filter((session) =>
    session.status === "archived" && session.updatedAt <= cutoff);
  return { days: normalized, cutoff, eligible };
}
