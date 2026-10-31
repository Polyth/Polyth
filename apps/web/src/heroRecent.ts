// Fresh-chat Recent list selection, kept pure so the widget's settings
// (count, status filter, subagents, project scope) are testable without React.
import type { SessionProjection, SessionSummaryQuery } from "@polyth/contracts";
import { resolveSessionStatus, type SessionStatusKind } from "./sessionStatus.ts";
import type { HeroRecentPrefs } from "./heroWidgetPrefs.ts";

/** Live work and work waiting on a person — what "Active" means here. */
const ACTIVE_KINDS: ReadonlySet<SessionStatusKind> = new Set([
  "working",
  "needs-approval",
  "needs-reply",
  "reconciling",
]);

export function heroRecentTimestamp(session: Pick<SessionProjection, "lastTurnAt" | "createdAt">): number {
  return session.lastTurnAt ?? session.createdAt;
}

/** Project ids the list draws from; null means every project. */
export function heroRecentProjectIds(
  prefs: Pick<HeroRecentPrefs, "scope" | "projectIds">,
  currentProjectId: string | null,
): ReadonlySet<string> | null {
  if (prefs.scope === "all") return null;
  if (prefs.scope === "selected") return new Set(prefs.projectIds);
  return new Set(currentProjectId ? [currentProjectId] : []);
}

export function selectHeroRecentSessions(
  sessions: readonly SessionProjection[],
  prefs: HeroRecentPrefs,
  currentProjectId: string | null,
  now = Date.now(),
  limit = prefs.limit,
): SessionProjection[] {
  const projects = heroRecentProjectIds(prefs, currentProjectId);
  return sessions
    .filter((session) => {
      if (session.status === "archived") return false;
      if (projects && !projects.has(session.projectId)) return false;
      if (!prefs.subagents && session.parentId) return false;
      if (prefs.filter === "unread") return (session.attention?.unread ?? 0) > 0;
      if (prefs.filter === "active") return ACTIVE_KINDS.has(resolveSessionStatus(session, now).kind);
      return true;
    })
    .sort((a, b) => heroRecentTimestamp(b) - heroRecentTimestamp(a) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Rows the list renders up front and adds per scroll step. The viewport stays
 *  `prefs.limit` rows tall; one extra screenful below it is what makes the list
 *  scrollable at all. */
export function heroRecentPageSize(prefs: Pick<HeroRecentPrefs, "limit">): number {
  return Math.max(prefs.limit, 6);
}

/** The server summary query that backs "more" once the cached rows run out.
 *  Project scope narrows on the server only when it names exactly one project;
 *  status and subagent filters stay client-side so paging order is unchanged. */
export function heroRecentSummaryQuery(
  prefs: Pick<HeroRecentPrefs, "scope" | "projectIds">,
  currentProjectId: string | null,
): SessionSummaryQuery {
  const projects = heroRecentProjectIds(prefs, currentProjectId);
  const projectId = projects?.size === 1 ? [...projects][0] : undefined;
  return { archived: false, limit: 30, ...(projectId ? { projectId } : {}) };
}

/** Whether any setting narrows the list beyond "this project's newest". An
 *  empty narrowed list still renders its settings control so the user can undo
 *  the filter; an empty default list renders nothing. */
export function heroRecentIsNarrowed(prefs: HeroRecentPrefs): boolean {
  return prefs.filter !== "all" || prefs.scope === "selected";
}
