// "Shared / Only me" under a project with other people in it. Each lane is a
// real project; the switch only moves the person between them.
import { useEffect } from "react";
import type { Project } from "@polyth/contracts";
import { tr } from "../i18n/index.ts";
import { ensureSessionsListed } from "../init.ts";
import { inPrivateLane, laneWaiting, offersPrivateRoom, openPrivateLane, openSharedLane, privateRoomOf } from "../privateRoom.ts";
import { workspaceProjectId, useStore } from "../store.ts";
import { Icon, LockIcon, SharedIcon } from "./ui/index.ts";
import "./PrivateRoomSwitch.css";

export default function PrivateRoomSwitch({ project, onSwitched }: { project: Project; onSwitched?: () => void }) {
  const activeProject = useStore((state) => {
    const id = workspaceProjectId(state);
    return state.projectRegistry.projects.find((candidate) => candidate.id === id);
  });
  const privateLane = inPrivateLane(project, activeProject);
  const roomId = useStore((state) => privateRoomOf(state.projectRegistry.projects, project.id)?.id);
  const offered = offersPrivateRoom(project);
  const otherLaneWaits = useStore((state) => offered && laneWaiting(state.sessions, privateLane ? project.id : roomId));
  // The room's chats are listed only once it has been opened; what's waiting there must show before that.
  useEffect(() => { if (offered && roomId) void ensureSessionsListed(roomId); }, [offered, roomId]);
  if (!offered) return null;
  const choices = [
    { key: "shared", selected: !privateLane, label: tr("privateRoom.shared"), icon: SharedIcon, select: () => openSharedLane(project) },
    { key: "private", selected: privateLane, label: tr("privateRoom.onlyMe"), icon: LockIcon, select: () => { void openPrivateLane(project); } },
  ] as const;
  return (
    <div className="private-room-switch" role="group" aria-label={tr("privateRoom.switch")} data-arrange-control="">
      {choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          className="private-room-switch-option"
          aria-pressed={choice.selected}
          onClick={() => {
            if (choice.selected) return;
            choice.select();
            onSwitched?.();
          }}
        >
          <Icon icon={choice.icon} size="sm" />
          <span>{choice.label}</span>
          {!choice.selected && otherLaneWaits && <span className="private-room-switch-waiting" role="img" aria-label={tr("privateRoom.waiting")} />}
        </button>
      ))}
    </div>
  );
}
