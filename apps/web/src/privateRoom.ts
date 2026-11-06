// "Only me" inside a project: a person's private room (Project.parentProjectId),
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

/** Starting a private chat is offered once someone else really works in a
 *  project; being able to open it isn't enough (`othersHere`). */
export const offersPrivateRoom = (project: Pick<Project, "othersHere" | "personal" | "parentProjectId">): boolean =>
  project.othersHere === true && !project.personal && !project.parentProjectId;

type RoomSession = Pick<SessionProjection, "projectId" | "status" | "attention" | "parentId">;

/** A room's own chats: what its row counts. Delegated children ride inside them. */
export const roomChatCount = (sessions: readonly RoomSession[], roomId: string | undefined): number =>
  roomId === undefined ? 0 : sessions.filter((session) => session.projectId === roomId && session.status !== "archived" && !session.parentId).length;

/** Whether a chat in a room is waiting for its person, for when its row is closed. */
export const roomWaiting = (sessions: readonly RoomSession[], roomId: string | undefined): boolean =>
  roomId !== undefined && sessions.some((session) => session.projectId === roomId && session.status !== "archived"
    && ((session.attention?.questions ?? 0) > 0 || (session.attention?.permissions ?? 0) > 0 || (session.attention?.unread ?? 0) > 0));

/** Whether the interface should say that others read a chat. Silence is the
 *  norm: someone else's chat or one given to someone by name always speaks,
 *  while a chat merely open to the Space speaks once someone else really works
 *  in its project. An unknown project errs on the side of saying so. */
export const othersRead = (
  sharing: SessionProjection["sharing"],
  project: Pick<Project, "othersHere"> | undefined,
): boolean => {
  if (!sharing?.shared) return false;
  if (sharing.owner || sharing.named || sharing.visibility === "restricted") return true;
  return !project || project.othersHere === true;
};

const projectOf = (session: Pick<SessionProjection, "projectId">): Project | undefined =>
  getState().projectRegistry.projects.find((project) => project.id === session.projectId);

export const chatReadByOthers = (session: Pick<SessionProjection, "projectId" | "sharing">): boolean =>
  othersRead(session.sharing, projectOf(session));

/** Whether which memory the agent has is worth a line: alone, there is nothing to tell apart. */
export const chatAmongOthers = (session: Pick<SessionProjection, "projectId" | "sharing">): boolean => {
  const project = projectOf(session);
  return session.sharing?.multiPerson === true
    && (project?.parentProjectId !== undefined || project?.othersHere === true || othersRead(session.sharing, project));
};

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

/** A new chat in the person's room, which is created the first time. */
export async function startPrivateChat(parent: Pick<Project, "id">): Promise<void> {
  const room = await openRoom(parent.id);
  if (room) startFreshSession(room.id);
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
