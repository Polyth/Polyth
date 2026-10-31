// New-session project order: projects with more recent chats rise to the top.
// Kept pure so the ranking is testable without React or the server.
import { useEffect, useMemo, useState } from "react";
import type { SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { useStore } from "./store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A chat this old counts half as much as one from right now. */
export const PROJECT_RECENCY_HALF_LIFE_MS = 7 * DAY_MS;
/** Chats older than this no longer affect the order. */
export const PROJECT_RECENCY_WINDOW_MS = 30 * DAY_MS;

type RecencySession = Pick<SessionProjection, "id" | "projectId" | "parentId" | "lastTurnAt" | "createdAt">;

/** Each top-level chat adds a weight that halves every half-life, so many
 *  chats this week outrank a few today and a busy month long ago fades out.
 *  Delegated children are the parent's work, not chats a person started. */
export function projectRecencyScores(
  sessions: readonly RecencySession[],
  now = Date.now(),
): Map<string, { score: number; latest: number }> {
  const scores = new Map<string, { score: number; latest: number }>();
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.parentId || !session.projectId || seen.has(session.id)) continue;
    seen.add(session.id);
    const at = session.lastTurnAt ?? session.createdAt;
    const age = Math.max(0, now - at);
    if (age > PROJECT_RECENCY_WINDOW_MS) continue;
    const entry = scores.get(session.projectId) ?? { score: 0, latest: 0 };
    entry.score += 0.5 ** (age / PROJECT_RECENCY_HALF_LIFE_MS);
    entry.latest = Math.max(entry.latest, at);
    scores.set(session.projectId, entry);
  }
  return scores;
}

/** Highest score first, then the most recent chat; projects without recent
 *  chats keep their registry order after the active ones. */
export function rankProjectsByRecentSessions<T extends { id: string }>(
  projects: readonly T[],
  sessions: readonly RecencySession[],
  now = Date.now(),
): T[] {
  const scores = projectRecencyScores(sessions, now);
  return projects
    .map((project, index) => ({ project, index, rank: scores.get(project.id) }))
    .sort((a, b) =>
      (b.rank?.score ?? 0) - (a.rank?.score ?? 0)
      || (b.rank?.latest ?? 0) - (a.rank?.latest ?? 0)
      || a.index - b.index)
    .map(({ project }) => project);
}

/** The store holds only the projects the client has opened, so one bounded
 *  cross-project summary read supplies the rest. A failed read falls back to
 *  the loaded sessions; the read is not put into the store, so it never adds
 *  rows to the navigator. */
export function useRecentlyActiveProjects<T extends { id: string }>(
  projects: readonly T[],
  enabled: boolean,
  spaceId: string,
): T[] {
  const loaded = useStore((state) => state.sessions);
  const [recent, setRecent] = useState<readonly SessionProjection[]>([]);
  useEffect(() => {
    setRecent([]);
    if (!enabled) return;
    const controller = new AbortController();
    void api.listSessionSummaries({ fromTime: Date.now() - PROJECT_RECENCY_WINDOW_MS, limit: 100 }, controller.signal)
      .then((page) => { if (!controller.signal.aborted) setRecent(page.sessions); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled, spaceId]);
  return useMemo(
    () => (enabled ? rankProjectsByRecentSessions(projects, [...loaded, ...recent]) : [...projects]),
    [enabled, projects, loaded, recent],
  );
}
