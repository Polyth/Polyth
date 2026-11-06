// "Only me" inside a shared project: a person's private room (Project.parentProjectId),
// a real project with its own folder and chats that the shell shows under its
// parent rather than beside it. The registry holds it so a chat in it finds its
// project; pickers and lists read `rootProjects`.
import { rootProjects, type Project, type SessionProjection } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { tr } from "./i18n/index.ts";
import { friendlyError } from "./settings.ts";
import { applyProjectUpsert, getState, setUiError, startFreshSession, startNewSession } from "./store.ts";

export { rootProjects };

export const isPrivateRoom = (project: Pick<Project, "parentProjectId"> | null | undefined): boolean =>
  project?.parentProjectId !== undefined;

/** The project a room belongs to, or the project itself. */
export const rootProjectId = (projects: readonly Project[], id: string | null): string | null => {
  if (!id) return id;
  return projects.find((candidate) => candidate.id === id)?.parentProjectId ?? id;
};

/** One person's room in a project: the registry only ever holds its own. */
export const privateRoomOf = (projects: readonly Project[], parentId: string): Project | undefined =>
  projects.find((candidate) => candidate.parentProjectId === parentId);

/** The switch appears once a project has someone to be private from. */
export const offersPrivateRoom = (project: Pick<Project, "sharedWith" | "personal" | "parentProjectId">): boolean =>
  (project.sharedWith ?? 0) > 0 && !project.personal && !project.parentProjectId;

/** Whether a chat in this lane is waiting for its person: the lane is hidden
 *  while they're in the other one, so its rows can't say so themselves. */
export const laneWaiting = (sessions: readonly Pick<SessionProjection, "projectId" | "status" | "attention">[], laneId: string | undefined): boolean =>
  laneId !== undefined && sessions.some((session) => session.projectId === laneId && session.status !== "archived"
    && ((session.attention?.questions ?? 0) > 0 || (session.attention?.permissions ?? 0) > 0 || (session.attention?.unread ?? 0) > 0));

/** Which lane of `parent` the person is in, given the project on screen. */
export const inPrivateLane = (parent: Pick<Project, "id">, activeProject: Pick<Project, "parentProjectId"> | undefined): boolean =>
  activeProject?.parentProjectId === parent.id;

const openRoom = async (parentId: string): Promise<Project | undefined> => {
  try {
    const room = await api.ensurePrivateRoom(parentId);
    applyProjectUpsert(room);
    return room;
  } catch (cause) {
    setUiError(friendlyError(tr("privateRoom.unavailable"), cause));
    return undefined;
  }
};

/** Turn to "Only me": the person's room, created the first time. */
export async function openPrivateLane(parent: Pick<Project, "id">): Promise<void> {
  const room = await openRoom(parent.id);
  if (room) startFreshSession(room.id);
}

export function openSharedLane(parent: Pick<Project, "id">): void {
  startFreshSession(parent.id);
}

/** A new private chat that quotes where this one was. What was already said in
 *  the shared chat stays there; only the person's next words are private. */
export async function continuePrivately(session: Pick<SessionProjection, "projectId" | "title">): Promise<void> {
  const projects = getState().projectRegistry.projects;
  const parentId = rootProjectId(projects, session.projectId) ?? session.projectId;
  const room = await openRoom(parentId);
  if (!room) return;
  startNewSession(room.id, { draft: `${tr("privateRoom.continueQuote", { title: session.title })}\n\n` });
}
