import type { SessionProjection } from "@polyth/contracts";

export interface SessionRetentionSummary {
  days: number;
  cutoff: number;
  eligible: SessionProjection[];
}

/** Archived, active, and waiting sessions are never cleanup candidates. */
export function sessionRetentionSummary(
  sessions: readonly SessionProjection[],
  days: number,
  now = Date.now(),
): SessionRetentionSummary {
  const normalizedDays = Number.isFinite(days)
    ? Math.min(3650, Math.max(1, Math.round(days)))
    : 30;
  const cutoff = now - normalizedDays * 24 * 60 * 60_000;
  const eligible = sessions.filter((session) =>
    session.status !== "archived"
    && session.status !== "working"
    && session.status !== "waiting"
    && session.updatedAt <= cutoff);
  return { days: normalizedDays, cutoff, eligible };
}
