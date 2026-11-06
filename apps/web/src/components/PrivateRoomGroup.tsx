// A person's private chats under their project: one quiet row that exists only
// while there are chats behind it. Each room is a real project; the row just
// opens its list in place.
import { useEffect, type ReactNode } from "react";
import type { Project } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { ensureSessionsListed } from "../init.ts";
import { privateRoomOf, roomChatCount, roomWaiting } from "../privateRoom.ts";
import { useStore, workspaceProjectId } from "../store.ts";
import { ChevronRightIcon, Icon, LockIcon } from "./ui/index.ts";
import "./PrivateRoomGroup.css";

/** A room's chats are listed only when asked for, and its row needs them. */
export function useRoomChatsListed(): void {
  const roomIds = useStore((state) => state.projectRegistry.projects
    .filter((project) => project.parentProjectId !== undefined)
    .map((project) => project.id)
    .join(" "));
  useEffect(() => {
    for (const id of roomIds.split(" ")) if (id) void ensureSessionsListed(id);
  }, [roomIds]);
}

export default function PrivateRoomGroup({ project, expanded, onToggle, children }: {
  project: Project;
  /** Whether this room's id is in the navigator's expanded set. */
  expanded: (roomId: string) => boolean;
  onToggle: (roomId: string) => void;
  children: (roomId: string) => ReactNode;
}) {
  const roomId = useStore((state) => privateRoomOf(state.projectRegistry.projects, project.id)?.id);
  const count = useStore((state) => roomChatCount(state.sessions, roomId));
  const waiting = useStore((state) => roomWaiting(state.sessions, roomId));
  const here = useStore((state) => roomId !== undefined && workspaceProjectId(state) === roomId);
  const open = roomId !== undefined && count > 0 && expanded(roomId);
  // Arriving in the room shows where the person is; they can still close it.
  useEffect(() => {
    if (here && roomId && !expanded(roomId)) onToggle(roomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on arrival
  }, [here, roomId]);
  if (!roomId || (count === 0 && !here)) return null;
  return (
    <>
      <button
        type="button"
        className="private-room-row"
        aria-expanded={open}
        data-arrange-control=""
        onClick={() => onToggle(roomId)}
      >
        <span className="private-room-mark"><Icon icon={LockIcon} size="sm" /></span>
        <span className="private-room-label">{tr("privateRoom.onlyMe")}</span>
        {count > 0 && <span className="private-room-count">{count}</span>}
        <span className="private-room-end">
          {!open && waiting && <span className="private-room-waiting" role="img" aria-label={tr("privateRoom.waiting")} />}
          {count > 0 && <Icon icon={ChevronRightIcon} size="sm" className="private-room-chevron" />}
        </span>
      </button>
      {open && <div className="private-room-chats">{children(roomId)}</div>}
    </>
  );
}
