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
  "id" | "projectId" | "title" | "status" | "parentId" | "forkOf" | "purpose" | "origin" | "sharing" | "isolation" | "isolationSummary" | "branch">
  & Partial<Pick<SessionProjection, "worktreePath">>;

/** Another checkout of the chat's own project: a linked worktree or the
 *  project's main checkout. The Git package confirms and performs the move. */
export type SessionCheckoutTarget = { worktreePath: string } | { main: true };

/** Navigator key of a checkout: the worktree path, or `main`. */
export const checkoutTargetKey = (target: SessionCheckoutTarget): string =>
  "main" in target ? "main" : target.worktreePath;

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
  if (!canMoveSessionAnywhere(session, projects)) return false;
  // Per navigator row, per render: no list built just to ask whether it's empty.
  return projects.some((project) => !project.parentProjectId && !project.remote && project.id !== session.projectId);
}

/** The chat-level half of {@link canMoveSession}: whether this chat may leave
 *  where it works at all, to another project or another checkout of its own. */
export function canMoveSessionAnywhere(session: MovableSession, projects: readonly Project[]): boolean {
  if (!canManageSession(session) || session.status === "archived" || session.purpose || session.origin) return false;
  if (session.parentId && !session.forkOf && session.sharing?.inherited !== false) return false;
  if (isIsolatedSession(session)) return false;
  const source = projects.find((project) => project.id === session.projectId);
  return !!source && !source.parentProjectId && !source.remote;
}

// ---- a drop on another checkout of the same project ---------------------------
// The host only notices the drop; the Git package's `session.checkout.move` slot
// renders the confirmation, which asks the server and words its answer.

export interface PendingCheckoutMove {
  sessionId: string;
  projectId: string;
  target: SessionCheckoutTarget;
}
let pendingCheckoutMove: PendingCheckoutMove | null = null;
const pendingListeners = new Set<() => void>();
const setPendingCheckoutMove = (next: PendingCheckoutMove | null): void => {
  pendingCheckoutMove = next;
  for (const listener of pendingListeners) listener();
};
const subscribePending = (listener: () => void): (() => void) => {
  pendingListeners.add(listener);
  return () => pendingListeners.delete(listener);
};
/** The checkout move waiting for its confirmation, if any. */
export const usePendingCheckoutMove = (): PendingCheckoutMove | null =>
  useSyncExternalStore(subscribePending, () => pendingCheckoutMove, () => null);
export const closePendingCheckoutMove = (): void => setPendingCheckoutMove(null);

const BLOCKED: Readonly<Record<SessionMoveBlockReason, TranslationKey>> = {
  archived: "sessionMove.blocked.archived",
  busy: "sessionMove.blocked.busy",
  delegated: "sessionMove.blocked.delegated",
  isolated: "sessionMove.blocked.isolated",
  "other-machine": "sessionMove.blocked.otherMachine",
  "package-owned": "sessionMove.blocked.packageOwned",
  "personal-context": "sessionMove.blocked.personalContext",
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
    // Every other refusal stays a refusal. "Personal notes already read" is the
    // person's own call, so it is asked for instead (Spaces §14.6).
    const personalNotes = preview.blocked?.reason === "personal-context";
    if (preview.blocked && !personalNotes) {
      setUiError(tr(BLOCKED[preview.blocked.reason]) || preview.blocked.message);
      return false;
    }
    const confirmed = await confirmAlert(
      personalNotes ? `${sessionMoveMessage(title, from, to, preview)}\n\n${tr("sessionMove.personalNotes")}` : sessionMoveMessage(title, from, to, preview),
      {
        title: tr("sessionMove.confirmTitle", { project: to }),
        confirmLabel: tr("sessionMove.confirmAction"),
        destructive: false,
        // The message already says what changes; the checkbox is the decision.
        ...(personalNotes ? { acknowledge: { label: tr("sessionMove.personalNotesConfirm") } } : {}),
      },
    );
    if (!confirmed) return false;
    const result = await api.moveSession(session.id, personalNotes ? { ...input, acknowledgePersonalContext: true } : input);
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

/** The chat being dragged right now, for drop targets that only appear mid-drag. */
export const useDraggedSession = (): MovableSession | null =>
  useSyncExternalStore(subscribe, () => dragged, () => null);

// The checkout under the pointer. The one listener lives on the navigator, the
// checkout rows deep inside each project's chat list, so it is shared here.
let overCheckoutKey: string | null = null;
const overListeners = new Set<() => void>();
const setOverCheckoutKey = (next: string | null): void => {
  if (overCheckoutKey === next) return;
  overCheckoutKey = next;
  for (const listener of overListeners) listener();
};
const subscribeOver = (listener: () => void): (() => void) => {
  overListeners.add(listener);
  return () => overListeners.delete(listener);
};
/** `checkoutTargetKey` of the checkout of `projectId` a chat is dragged over. */
export function useCheckoutDropOver(projectId: string): string | null {
  const over = useSyncExternalStore(subscribeOver, () => overCheckoutKey, () => null);
  const prefix = `${projectId}\n`;
  return over?.startsWith(prefix) ? over.slice(prefix.length) : null;
}

const sameCheckout = (session: MovableSession, target: SessionCheckoutTarget): boolean =>
  "main" in target ? !session.worktreePath : session.worktreePath === target.worktreePath;

/** Read a checkout drop target. An element marks itself with
 *  `data-session-drop-checkout` (`main` or the worktree path) and
 *  `data-session-drop-checkout-project`; only the dragged chat's own project,
 *  and only a checkout other than the one it works in, counts. */
function checkoutTargetAt(element: Element | null | undefined, session: MovableSession): SessionCheckoutTarget | null {
  const zone = element?.closest?.("[data-session-drop-checkout]");
  if (!zone || zone.getAttribute("data-session-drop-checkout-project") !== session.projectId) return null;
  const key = zone.getAttribute("data-session-drop-checkout");
  if (!key) return null;
  const target: SessionCheckoutTarget = key === "main" ? { main: true } : { worktreePath: key };
  return sameCheckout(session, target) ? null : target;
}

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
  const setOverCheckout = (key: string | null): void =>
    setOverCheckoutKey(key && session ? `${session.projectId}\n${key}` : null);
  useEffect(() => {
    if (session) return;
    setOverProjectId(null);
    setOverCheckoutKey(null);
  }, [session]);

  type Target = { kind: "project"; project: Project } | { kind: "checkout"; target: SessionCheckoutTarget };
  const targetOf = (event: ReactDragEvent<HTMLElement>): Target | null => {
    if (!session || !Array.from(event.dataTransfer.types).includes(SESSION_MOVE_MIME)) return null;
    const under = event.target as Element | null;
    // A checkout sits inside its project's row, so it is asked first.
    const checkout = checkoutTargetAt(under, session);
    if (checkout) return { kind: "checkout", target: checkout };
    const element = under?.closest?.("[data-session-drop-project]");
    const id = element?.getAttribute("data-session-drop-project");
    const project = id ? sessionMoveTargets(session, getState().projectRegistry.projects).find((candidate) => candidate.id === id) : undefined;
    return project ? { kind: "project", project } : null;
  };
  const clear = (): void => {
    setOverProjectId(null);
    setOverCheckout(null);
  };

  return {
    overProjectId,
    handlers: {
      onDragOver: (event: ReactDragEvent<HTMLElement>) => {
        const target = targetOf(event);
        setOverProjectId(target?.kind === "project" ? target.project.id : null);
        setOverCheckout(target?.kind === "checkout" ? checkoutTargetKey(target.target) : null);
        if (!target) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clear();
      },
      onDrop: (event: ReactDragEvent<HTMLElement>) => {
        const target = targetOf(event);
        clear();
        if (!target || !session) return;
        event.preventDefault();
        const carried = session;
        endSessionMoveDrag();
        // Drag data is untrusted: it has to name the row that started this drag.
        if (getDragSessionMove(event.dataTransfer) !== carried.id) return;
        if (target.kind === "project") void requestSessionMove(carried, target.project);
        else setPendingCheckoutMove({ sessionId: carried.id, projectId: carried.projectId, target: target.target });
      },
    },
  };
}
