// What the navigator's Pinned group above the projects lists
// (`pinnedPlacement: "top"`, sidebarPrefs.ts; drawn by
// components/sidebar/PinnedSessions.tsx), and the project each row names.
import type { Project, SessionProjection } from "@polyth/contracts";
import { tr } from "./i18n/index.ts";
import { EMPTY_SESSION_DATE_FILTER, sessionMatchesDateFilter, sortPinnedSessions, type SessionDateFilter } from "./sessionDates.ts";
import { resolveSessionStatus } from "./sessionStatus.ts";

/** What the navigator's Needs attention filter keeps. */
export function sessionNeedsAttention(session: SessionProjection): boolean {
  return session.status === "working"
    || session.status === "waiting"
    || session.status === "reconciling"
    || session.status === "unknown"
    || resolveSessionStatus(session).kind === "epoch-pending"
    || (session.attention?.questions ?? 0) > 0
    || (session.attention?.permissions ?? 0) > 0;
}

/** The chat's project, as a row of the Pinned group draws it. */
export interface SessionProjectMark {
  project: Pick<Project, "icon" | "color" | "remote">;
  name: string;
  /** The initial drawn for a project without an icon of its own, so several
   *  of them stay apart in one list instead of all showing the default
   *  folder. Empty when the name has no letter or digit. */
  monogram: string;
}

/** A project's initial: the first letter or digit of its name ("Home
 *  Assistant" → "H", "polyth-site" → "P", "🚀 launch" → "L"). One letter, so
 *  it reads at the navigator's meta size inside the state column's disc; two
 *  letters there fell to ~7px. Symbols and emoji are skipped. */
export function projectMonogram(name: string): string {
  return name.normalize("NFC").match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? "";
}

/** The last segment of a project path, the name a nameless project goes by. */
const pathBasename = (path: string): string => path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;

/** The project a pinned chat names: a private room is drawn as its project,
 *  with the room's "Only me" after the name. */
export function sessionProjectMark(
  projectsById: ReadonlyMap<string, Project>,
  session: Pick<SessionProjection, "projectId">,
): (SessionProjectMark & { path: string }) | undefined {
  const own = projectsById.get(session.projectId);
  if (!own) return undefined;
  const root = (own.parentProjectId && projectsById.get(own.parentProjectId)) || own;
  const name = root.name || root.path;
  return {
    project: root,
    name: root === own ? name : `${name} · ${tr("privateRoom.onlyMe")}`,
    monogram: root.icon ? "" : projectMonogram(root.name || pathBasename(root.path)),
    path: root.path,
  };
}

/** The pinned chats the group lists, in pin order: live (not archived), in a
 *  project of this Space, and kept by the navigator's filters. */
export function pinnedAboveSessions(
  sessions: readonly SessionProjection[],
  projectsById: ReadonlyMap<string, Project>,
  { attentionOnly = false, dateFilter = EMPTY_SESSION_DATE_FILTER }: { attentionOnly?: boolean; dateFilter?: SessionDateFilter } = {},
): SessionProjection[] {
  return sortPinnedSessions(sessions.filter((session) => session.status !== "archived"
    && projectsById.has(session.projectId)
    && sessionMatchesDateFilter(session, dateFilter)
    && (!attentionOnly || sessionNeedsAttention(session))));
}
