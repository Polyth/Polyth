// Archived-sessions view model: pure filtering, merging and grouping for the
// per-project archive surface. The server orders summaries by `updatedAt`
// (the archive transition is the last update of an archived session, which is
// also what archive retention measures), so that is the "archived" date here.
import type { SessionProjection } from "@polyth/contracts";
import type { SessionSearchMatch, SessionSearchResult } from "@polyth/session/web-api";
import { sessionDateInputValue } from "./sessionDates.ts";

const DAY_MS = 24 * 60 * 60_000;

export const ARCHIVED_DATE_PRESETS = ["any", "today", "week", "month", "older"] as const;
export type ArchivedDatePreset = (typeof ARCHIVED_DATE_PRESETS)[number];

/** Sessions without a branch (the project checkout) share this branch key. */
export const ARCHIVED_MAIN_BRANCH = "";
export const ARCHIVED_ANY_BRANCH = "*";

export interface ArchivedEntry {
  session: SessionProjection;
  /** Best transcript hit for the current search, if any. */
  match?: SessionSearchMatch & { seq: number };
  messageHits: number;
}

export interface ArchivedFilters {
  preset: ArchivedDatePreset;
  branch: string;
}

export function archivedAt(session: Pick<SessionProjection, "updatedAt" | "lastTurnAt" | "createdAt">): number {
  return session.updatedAt ?? session.lastTurnAt ?? session.createdAt;
}

export function archivedBranchKey(session: Pick<SessionProjection, "branch">): string {
  return session.branch ?? ARCHIVED_MAIN_BRANCH;
}

/** Inclusive lower / exclusive upper archive-time bounds for a preset. */
export function archivedDateBounds(preset: ArchivedDatePreset, now = Date.now()): { from?: number; before?: number } {
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { from: start.getTime() };
  }
  if (preset === "week") return { from: now - 7 * DAY_MS };
  if (preset === "month") return { from: now - 30 * DAY_MS };
  if (preset === "older") return { before: now - 30 * DAY_MS };
  return {};
}

export function matchesArchivedFilters(entry: ArchivedEntry, filters: ArchivedFilters, now = Date.now()): boolean {
  const at = archivedAt(entry.session);
  const { from, before } = archivedDateBounds(filters.preset, now);
  if (from !== undefined && at < from) return false;
  if (before !== undefined && at >= before) return false;
  return filters.branch === ARCHIVED_ANY_BRANCH || archivedBranchKey(entry.session) === filters.branch;
}

/** Pages arrive newest-archived first, so a recency preset is satisfied once
 * the oldest loaded row predates its window; further pages cannot match. */
export function archivedPagingSatisfied(
  loaded: readonly SessionProjection[],
  preset: ArchivedDatePreset,
  now = Date.now(),
): boolean {
  const { from } = archivedDateBounds(preset, now);
  const oldest = loaded.at(-1);
  return from !== undefined && oldest !== undefined && archivedAt(oldest) < from;
}

/** Combine paged archived summaries with transcript hits. Hits enrich their
 * row; archived sessions found only through their messages join the list with
 * the metadata the search index returned. Non-archived hits are ignored. */
export function mergeArchivedEntries(
  rows: readonly SessionProjection[],
  hits: readonly SessionSearchResult[],
  projectId: string,
): ArchivedEntry[] {
  const hitById = new Map(hits.map((hit) => [hit.sessionId, hit] as const));
  const bestMatch = (hit: SessionSearchResult | undefined) => hit?.matches
    .find((match): match is SessionSearchMatch & { seq: number } => match.field === "message" && typeof match.seq === "number");
  const seen = new Set<string>();
  const entries: ArchivedEntry[] = [];
  for (const session of rows) {
    if (seen.has(session.id) || session.status !== "archived") continue;
    seen.add(session.id);
    const hit = hitById.get(session.id);
    const match = bestMatch(hit);
    entries.push({ session, messageHits: hit?.messageHits ?? 0, ...(match ? { match } : {}) });
  }
  for (const hit of hits) {
    if (seen.has(hit.sessionId) || hit.status !== "archived" || hit.projectId !== projectId) continue;
    seen.add(hit.sessionId);
    const match = bestMatch(hit);
    entries.push({
      session: {
        id: hit.sessionId,
        projectId: hit.projectId,
        title: hit.title,
        status: "archived",
        createdAt: hit.updatedAt,
        updatedAt: hit.updatedAt,
        summary: true,
      } as SessionProjection,
      messageHits: hit.messageHits,
      ...(match ? { match } : {}),
    });
  }
  return entries.sort((a, b) => archivedAt(b.session) - archivedAt(a.session) || a.session.id.localeCompare(b.session.id));
}

export interface ArchivedDayGroup {
  key: string;
  timestamp: number;
  entries: ArchivedEntry[];
}

export function groupArchivedByDay(entries: readonly ArchivedEntry[]): ArchivedDayGroup[] {
  const groups: ArchivedDayGroup[] = [];
  for (const entry of entries) {
    const timestamp = archivedAt(entry.session);
    const key = sessionDateInputValue(timestamp);
    const previous = groups.at(-1);
    if (previous?.key === key) previous.entries.push(entry);
    else groups.push({ key, timestamp, entries: [entry] });
  }
  return groups;
}

/** Branch filter options observed in the loaded archive, most used first. */
export function archivedBranchOptions(entries: readonly ArchivedEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = archivedBranchKey(entry.session);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}
