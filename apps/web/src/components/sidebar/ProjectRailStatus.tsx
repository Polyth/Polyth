// A project's status, in three channels that never cover one another:
// - the seal (top end corner): chats that wait on a person, in the most
//   urgent kind's tone, with a real cut-out in the icon under it;
// - the halo (the tile's contour): light running round it while chats work,
//   amber and slower while they reconnect, still while they will continue by
//   themselves;
// - the pip (the rail's start edge): a reply nobody has read.
// The tree row (ProjectTreeStatus) reads the same projectStatusSignal.
import type { ProjectRailStatus } from "../../sessionStatus.ts";
import { projectStatusSignal } from "../../sessionStatus.ts";
import { tr } from "../../i18n/index.ts";
import { SEAL_MAX_COUNT, SealContent, sealCountText } from "../StatusSeal.tsx";

export function ProjectRailMarks({ status }: { status: ProjectRailStatus }) {
  const { seal, activity, unread } = projectStatusSignal(status);
  return (
    <>
      {activity && (
        <span className="sidebar-project-rail-halo" data-activity={activity} aria-hidden="true">
          <span className="sidebar-project-rail-halo-ring"><span className="sidebar-project-rail-halo-comet" /></span>
        </span>
      )}
      {seal && (
        <span
          className="sidebar-project-rail-seal status-seal"
          data-kind={seal.kind}
          data-wide={seal.count > SEAL_MAX_COUNT ? "" : undefined}
          aria-hidden="true"
        >
          <SealContent kind={seal.kind} count={seal.count} />
        </span>
      )}
      {unread > 0 && <span className="sidebar-project-rail-pip" aria-hidden="true" />}
    </>
  );
}

/** Requests and running chats are always loaded, so their counts are exact.
 *  Results past the cap are only known to be more than it. Most urgent first,
 *  in the order the seal picks its tone. */
function statusLines(status: ProjectRailStatus) {
  return [
    { kind: "is-permission", count: status.permissions, text: String(status.permissions), label: tr("sessionStatus.approvalRequired") },
    { kind: "is-question", count: status.questions, text: String(status.questions), label: tr("sessionStatus.replyNeeded") },
    { kind: "is-failed", count: status.failed, text: String(status.failed), label: tr("sessionStatus.failed") },
    { kind: "is-runtime", count: status.runtime, text: String(status.runtime), label: tr("sessionStatus.runtimeChanged") },
    { kind: "is-working", count: status.working, text: String(status.working), label: tr("sessionStatus.working") },
    { kind: "is-reconciling", count: status.reconciling, text: String(status.reconciling), label: tr("sessionStatus.reconnecting") },
    { kind: "is-paused", count: status.limited, text: String(status.limited), label: tr("sessionStatus.resumesAfterLimit") },
    { kind: "is-paused", count: status.awaiting, text: String(status.awaiting), label: tr("sessionStatus.awaiting") },
    { kind: "is-result", count: status.results, text: sealCountText(status.results), label: tr("sidebar.sessionlist.unreadActivity") },
  ].filter((line) => line.count > 0);
}

/** What a sighted pointer reads in the tooltip, for a screen reader. */
export function projectRailStatusLabel(name: string, status: ProjectRailStatus): string {
  return [name, ...statusLines(status).map((line) => `${line.label}: ${line.text}`)].join(". ");
}

/** The same lines without the name, for a row whose name is already read. */
export function projectStatusSummary(status: ProjectRailStatus): string {
  return statusLines(status).map((line) => `${line.label}: ${line.text}`).join(". ");
}

export function ProjectRailStatusLines({ status }: { status: ProjectRailStatus }) {
  const lines = statusLines(status);
  if (lines.length === 0) return null;
  return (
    <span className="sidebar-project-rail-tooltip-status">
      {lines.map((line) => (
        <span key={`${line.kind}:${line.label}`} className="sidebar-project-rail-tooltip-line">
          <span className={`sidebar-project-rail-tooltip-swatch ${line.kind}`} />
          <span className="sidebar-project-rail-tooltip-count">{line.text}</span>
          <span className="sidebar-project-rail-tooltip-label">{line.label}</span>
        </span>
      ))}
    </span>
  );
}
