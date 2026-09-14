import type { SessionProjection } from "@polyth/contracts";

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
