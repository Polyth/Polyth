// Moving a chat to another project: who may offer it, the drag between the
// navigator's rows and project rows, and the one confirmed request behind every
// way of asking. The server decides; everything here only avoids offering what
// it would refuse, and words its answer.
import { useEffect, useState, useSyncExternalStore, type DragEvent as ReactDragEvent } from "react";
import {
  rootProjects,
  type Project,
  type SessionMoveBlockReason,
  type SessionMovePreview,
  type SessionPerson,
  type SessionProjection,
} from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { confirmAlert } from "./alerts.ts";
import { announce } from "./components/a11y/announce.ts";
import { getDragSessionMove, SESSION_MOVE_MIME, setDragSessionMove } from "./dnd.ts";
import { tr, type TranslationKey } from "./i18n/index.ts";
import { friendlyError } from "./settings.ts";
import { canManageSession } from "./sessionSharing.ts";
import { isIsolatedSession } from "./sidebarPrefs.ts";
import { getState, setUiError, upsertSession } from "./store.ts";

type MovableSession = Pick<SessionProjection,
  "id" | "projectId" | "title" | "status" | "parentId" | "purpose" | "origin" | "sharing" | "isolation" | "isolationSummary" | "branch">;

const projectName = (project: Pick<Project, "name" | "path"> | undefined): string =>
  project?.name || project?.path || tr("sessionMove.unknownProject");

/** Projects this chat could go to. A private room reads as its project on
 *  screen and isn't a place to move a chat to; a remote one is another machine. */
export function sessionMoveTargets(session: Pick<SessionProjection, "projectId">, projects: readonly Project[]): Project[] {
  return rootProjects(projects).filter((project) => project.id !== session.projectId && !project.remote);
}

/** Whether to offer the move at all. A delegated subagent goes with its chat; a
 *  fork is a chat of its own, which only the sharing view can tell apart. */
export function canMoveSession(session: MovableSession, projects: readonly Project[]): boolean {
  if (!canManageSession(session) || session.status === "archived" || session.purpose || session.origin) return false;
  if (session.parentId && session.sharing?.inherited !== false) return false;
  if (isIsolatedSession(session)) return false;
  const source = projects.find((project) => project.id === session.projectId);
  if (!source || source.parentProjectId || source.remote) return false;
  // Per navigator row, per render: no list built just to ask whether it's empty.
  return projects.some((project) => !project.parentProjectId && !project.remote && project.id !== session.projectId);
}

const BLOCKED: Readonly<Record<SessionMoveBlockReason, TranslationKey>> = {
  archived: "sessionMove.blocked.archived",
  busy: "sessionMove.blocked.busy",
  delegated: "sessionMove.blocked.delegated",
  isolated: "sessionMove.blocked.isolated",
  "other-machine": "sessionMove.blocked.otherMachine",
  "package-owned": "sessionMove.blocked.packageOwned",
  private: "sessionMove.blocked.private",
  queued: "sessionMove.blocked.queued",
  "too-large": "sessionMove.blocked.tooLarge",
  unsupported: "sessionMove.blocked.unsupported",
  widening: "sessionMove.blocked.widening",
};

const peopleList = (people: readonly SessionPerson[]): string =>
  people.map((person) => person.name || tr("timeline.anotherPerson")).join(", ");

/** The confirmation names everything the move does that can't be seen from the
 *  navigator, and nothing else. */
export function sessionMoveMessage(title: string, from: string, to: string, preview: SessionMovePreview): string {
  const subagents = preview.sessionIds.length - 1;
  return [
    tr("sessionMove.confirmBody", { title, from, to }),
    subagents === 1 ? tr("sessionMove.subagentsOne") : subagents > 1 ? tr("sessionMove.subagentsMany", { count: subagents }) : "",
    preview.restartsAgent ? tr("sessionMove.restart", { from, to }) : tr("sessionMove.filesStay", { from }),
    preview.gains.length ? tr("sessionMove.gains", { people: peopleList(preview.gains) }) : "",
    preview.loses.length ? tr("sessionMove.loses", { people: peopleList(preview.loses) }) : "",
  ].filter(Boolean).join("\n\n");
}

/** Ask, confirm, move. Resolves true only when the chat moved. */
export async function requestSessionMove(session: Pick<SessionProjection, "id" | "projectId" | "title">, target: Project): Promise<boolean> {
  const from = projectName(getState().projectRegistry.projects.find((project) => project.id === session.projectId));
  const to = projectName(target);
  const title = session.title || tr("sidebar.sessionlist.session");
  const input = { projectId: target.id, expectedProjectId: session.projectId };
  try {
    const preview = await api.previewSessionMove(session.id, input);
    if (preview.blocked) {
      setUiError(tr(BLOCKED[preview.blocked.reason]) || preview.blocked.message);
      return false;
    }
    const confirmed = await confirmAlert(sessionMoveMessage(title, from, to, preview), {
      title: tr("sessionMove.confirmTitle", { project: to }),
      confirmLabel: tr("sessionMove.confirmAction"),
      destructive: false,
    });
    if (!confirmed) return false;
    const result = await api.moveSession(session.id, input);
    upsertSession(result.session);
    announce(tr("sessionMove.moved", { project: to }));
    return true;
  } catch (error) {
    setUiError(friendlyError(tr("sessionMove.failed"), error));
    return false;
  }
}

// ---- the drag ----------------------------------------------------------------
// A dragover can't read the payload, so the row announces what it carries here
// and a project row can light up, or not, while the pointer is still on the way.

let dragged: MovableSession | null = null;
const listeners = new Set<() => void>();
const publish = (next: MovableSession | null): void => {
  if (dragged === next) return;
  dragged = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function beginSessionMoveDrag(dataTransfer: DataTransfer, session: MovableSession): void {
  setDragSessionMove(dataTransfer, session.id);
  publish(session);
}
export const endSessionMoveDrag = (): void => publish(null);

/**
 * One listener on the navigator rather than one per project row: a row is a
 * tree card or a rail tile deep inside a menu and tooltip, and only the row
 * under the pointer ever changes. An element marks itself a place to drop on
 * with `data-session-drop-project`; `overProjectId` is the project under the
 * pointer. A row unmounted mid-drag never reports its `dragend`, so a drag also
 * has to carry the payload type before the remembered chat means anything.
 */
export function useSessionMoveDropZones() {
  const session = useSyncExternalStore(subscribe, () => dragged, () => null);
  const [overProjectId, setOverProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (!session) setOverProjectId(null);
  }, [session]);

  const targetOf = (event: ReactDragEvent<HTMLElement>): Project | null => {
    if (!session || !Array.from(event.dataTransfer.types).includes(SESSION_MOVE_MIME)) return null;
    const element = (event.target as Element | null)?.closest?.("[data-session-drop-project]");
    const id = element?.getAttribute("data-session-drop-project");
    return (id && sessionMoveTargets(session, getState().projectRegistry.projects).find((project) => project.id === id)) || null;
  };

  return {
    overProjectId,
    handlers: {
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        const target = targetOf(event);
        setOverProjectId(target?.id ?? null);
        if (!target) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverProjectId(null);
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        const target = targetOf(event);
        setOverProjectId(null);
        if (!target || !session) return;
        event.preventDefault();
        const carried = session;
        endSessionMoveDrag();
        // Drag data is untrusted: it has to name the row that started this drag.
        if (getDragSessionMove(event.dataTransfer) === carried.id) void requestSessionMove(carried, target);
      },
    },
  };
}
