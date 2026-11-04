// Fresh-chat Recent list selection, kept pure so the widget's settings
// (count, status filter, subagents, automated sessions, project scope) are
// testable without React.
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

/** No package claims a purpose: the pure default every older caller gets. */
const NO_CLAIMED_PURPOSES: ReadonlySet<string> = new Set();

/** The fields "did an automation start this?" reads, so callers can pass any
 *  session-shaped row (summary or full projection). */
export type AutomationSession = Pick<SessionProjection, "id" | "purpose" | "parentId" | "origin">;

/** Whether an automation started this session: it carries an `origin` (an
 *  agent's own run, a monitoring incident chat), its `purpose` is a purpose a
 *  package presents in its own UI (legacy agent sessions from before `origin`
 *  existed), or its parent is such a session (the agent's own subagent tree).
 *  `byId` must hold every session the list was given, not just the matching
 *  ones, so a child is recognized even when its parent is filtered out. */
export function isAutomatedSession(
  session: AutomationSession,
  byId: ReadonlyMap<string, AutomationSession>,
  claimedPurposes: ReadonlySet<string> = NO_CLAIMED_PURPOSES,
): boolean {
  const seen = new Set<string>();
  let current: AutomationSession | undefined = session;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.origin) return true;
    if (current.purpose && claimedPurposes.has(current.purpose)) return true;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

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
  claimedPurposes: ReadonlySet<string> = NO_CLAIMED_PURPOSES,
): SessionProjection[] {
  const projects = heroRecentProjectIds(prefs, currentProjectId);
  // Parent lookups see every session handed in, including ones the filters
  // below drop, because an automated parent still makes its child automated.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return sessions
    .filter((session) => {
      if (session.status === "archived") return false;
      if (projects && !projects.has(session.projectId)) return false;
      if (!prefs.subagents && session.parentId) return false;
      if (!prefs.automated && isAutomatedSession(session, byId, claimedPurposes)) return false;
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
