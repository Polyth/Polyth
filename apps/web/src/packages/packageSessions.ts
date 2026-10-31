// Chats a package owns. A package that declares a workbench profile with
// `sessionPurpose` (Creative Studio, Playground, Monitoring…) makes its own
// chat lane. Turning the package off leaves those chats behind: their purpose
// is package-owned for the session's whole life, so the host still recognises
// them even after the profile is gone, and this module lets the disable flow
// offer to clean them up or hide them.
//
// Generic by construction: it never names a package. A package's purposes come
// from `sessionPurposesOfPackage`, which the host records when the profile
// registers (see workbench/profiles.ts), so any new package with custom
// sessions is covered the day it ships.
//
// Lane membership is decided by the shared `lanePurposeOf` rule, not by the
// stored `purpose` field: a delegated child carries no purpose of its own and
// belongs to its nearest ancestor's lane, so a chat that spawned builders is
// only fully hidden when those builders are found too. The server cannot
// express that rule in one indexed page read, so this walks pages of the
// Space's chats and resolves each session's lane locally.
import type { SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { getState, upsertSessions } from "../store.ts";
import { lanePurposeOf, type LaneSession } from "../workbench/lanes.ts";
import { sessionPurposesOfPackage } from "../workbench/profiles.ts";

/** Page walk bound. A package lane is normally a handful of chats; the cap
 *  keeps a settings toggle from turning into an unbounded scan and is reported
 *  (`truncated`) instead of silently touching a subset. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export interface PackageSessionOwner {
  packageId: string;
  purposes: readonly string[];
  /** Live lane chats: the roots and every delegated descendant. */
  sessions: readonly SessionProjection[];
  /** Package-lane chats already archived by the user or a previous disable. */
  archivedCount: number;
  /** True when the page walk hit its bound, so this description may be partial. */
  truncated: boolean;
}

async function walk(archived: boolean): Promise<{ sessions: SessionProjection[]; truncated: boolean }> {
  const sessions: SessionProjection[] = [];
  let cursor: { updatedAt: number; id: string } | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await api.listSessionSummaries({
      archived,
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    sessions.push(...result.sessions);
    if (result.complete || !result.next) return { sessions, truncated: false };
    cursor = result.next;
  }
  return { sessions, truncated: true };
}

/**
 * Chats owned by `packageId`, or null when the package owns no session lane
 * (nothing to ask about) or owns no chats right now.
 */
export async function findPackageSessions(
  packageId: string,
  purposes: readonly string[] = sessionPurposesOfPackage(packageId),
): Promise<PackageSessionOwner | null> {
  if (purposes.length === 0) return null;
  const known = new Set(purposes);
  // The ancestor walk needs a session's ancestors present even when the
  // ancestor is ordinary, so resolve against live and archived together.
  const [live, archived] = await Promise.all([walk(false), walk(true)]);
  const byId = new Map<string, LaneSession & SessionProjection>();
  for (const session of [...live.sessions, ...archived.sessions]) {
    byId.set(session.id, session as LaneSession & SessionProjection);
  }
  const inLane = (session: SessionProjection) =>
    known.has(lanePurposeOf(session as LaneSession, byId, (purpose) => known.has(purpose)));
  const sessions = live.sessions.filter(inLane);
  const archivedCount = archived.sessions.filter(inLane).length;
  if (sessions.length === 0 && archivedCount === 0) return null;
  return {
    packageId,
    purposes,
    sessions,
    archivedCount,
    truncated: live.truncated || archived.truncated,
  };
}

/** Re-read the active session list of every project the client has loaded, so
 *  a hide that happened off-screen (another project's package lane) is visible
 *  without a reload. Failures are ignored: the server broadcast reconciles
 *  whatever this best-effort refresh misses. */
export async function refreshLoadedProjectSessions(): Promise<void> {
  const projectIds = new Set(getState().sessions.map((session) => session.projectId));
  const active = getState().activeProjectId;
  if (active) projectIds.add(active);
  for (const projectId of projectIds) {
    try {
      const page = await api.listSessionSummaries({ projectId, limit: 50 });
      if (page.sessions.length > 0) upsertSessions(page.sessions);
    } catch {
      // Best-effort reconciliation only.
    }
  }
}

/** Archive every chat a package owns: reversible, keeps history and checkouts. */
export async function hidePackageSessions(owner: PackageSessionOwner): Promise<number> {
  const ids = owner.sessions.map((session) => session.id);
  if (ids.length === 0) return 0;
  const result = await api.bulkSessions("archive", ids);
  return result.succeeded.length;
}

/** Permanently remove every chat a package owns, one at a time so a single
 *  failure does not strand the rest. Returns how many were deleted. */
export async function deletePackageSessions(owner: PackageSessionOwner): Promise<number> {
  let deleted = 0;
  for (const session of owner.sessions) {
    await api.deleteSession(session.id);
    deleted += 1;
  }
  return deleted;
}
