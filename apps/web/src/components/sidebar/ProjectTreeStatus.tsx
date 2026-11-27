// A project's status on its tree row: the rail tile's reading
// (projectStatusSignal), laid out where the row has room for numbers. At the
// row's end a quiet counter of running chats (the session row's spinner) and
// the seal of what waits on a person; a pip on the navigator's start edge for
// an unread reply. It shares the row's end with the project actions: with a
// fine pointer the actions take its place on hover or focus. Decorative: the
// row's button carries ProjectTreeStatusLabel for its accessible name.
import type { ProjectRailStatus } from "../../sessionStatus.ts";
import { projectStatusSignal } from "../../sessionStatus.ts";
import UiIcon from "../ui/Icon.tsx";
import { TimerIcon } from "../ui/icons.ts";
import { SealGlyph, sealCountText } from "../StatusSeal.tsx";
import { projectStatusSummary } from "./ProjectRailStatus.tsx";

export function ProjectTreeStatus({ status }: { status: ProjectRailStatus }) {
  const { seal, activity, running, unread } = projectStatusSignal(status);
  if (!seal && !activity && unread === 0) return null;
  const moving = activity === "working" || activity === "reconciling";
  return (
    <>
      {unread > 0 && <span className="project-status-pip" aria-hidden="true" />}
      {(seal || activity) && (
        <span className="project-status" aria-hidden="true">
          {moving && (
            <span className="project-status-running" data-activity={activity}>
              <span className={`session-lead-spinner project-status-spinner${activity === "reconciling" ? " reconciling" : ""}`} />
              {running > 1 && <bdi dir="ltr">{running}</bdi>}
            </span>
          )}
          {activity === "paused" && <span className="project-status-paused"><UiIcon icon={TimerIcon} size="sm" /></span>}
          {seal && (
            <span className="project-status-seal status-seal" data-kind={seal.kind} data-solo={seal.count > 1 ? undefined : ""}>
              <SealGlyph kind={seal.kind} />
              {seal.count > 1 && <bdi dir="ltr">{sealCountText(seal.count)}</bdi>}
            </span>
          )}
        </span>
      )}
    </>
  );
}

/** The same status in words, inside the row's button. */
export function ProjectTreeStatusLabel({ status }: { status: ProjectRailStatus }) {
  const summary = projectStatusSummary(status);
  return summary ? <span className="sr-only">{`. ${summary}`}</span> : null;
}
