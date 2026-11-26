// Status marks on a project's rail icon. Each kind owns a corner, so the corner
// names the kind before its colour does: question at the top start, permission
// at the top end, result at the bottom end. The bottom start corner is free.
// Corners follow the shell's direction; only the text inside stays "9+".
import type { ProjectRailStatus } from "../../sessionStatus.ts";
import { tr } from "../../i18n/index.ts";

/** The server sends ten unread rows per project, which proves "9+". */
const MAX_COUNT = 9;

function countText(count: number): string {
  return count > MAX_COUNT ? `${MAX_COUNT}+` : String(count);
}

/** One chat shows what it is; several show how many. */
function blockingText(count: number, glyph: string): string {
  return count > 1 ? countText(count) : glyph;
}

export function ProjectRailMarks({ status }: { status: ProjectRailStatus }) {
  const { permissions, questions, results, working } = status;
  return (
    <>
      {questions > 0 && (
        <span className="sidebar-project-rail-mark is-question" aria-hidden="true"><bdi dir="ltr">{blockingText(questions, "?")}</bdi></span>
      )}
      {permissions > 0 && (
        <span className="sidebar-project-rail-mark is-permission" aria-hidden="true"><bdi dir="ltr">{blockingText(permissions, "!")}</bdi></span>
      )}
      {results > 1 && (
        <span className="sidebar-project-rail-mark is-result" aria-hidden="true"><bdi dir="ltr">{countText(results)}</bdi></span>
      )}
      {results === 1 && <span className="sidebar-project-rail-mark is-result is-dot" aria-hidden="true" />}
      {results === 0 && working > 0 && (
        <span className="sidebar-project-rail-mark is-working is-dot" aria-hidden="true" />
      )}
    </>
  );
}

/** Requests and running chats are always loaded, so their counts are exact.
 *  Results past the cap are only known to be more than it. */
function statusLines(status: ProjectRailStatus) {
  return [
    { kind: "is-permission", count: status.permissions, text: String(status.permissions), label: tr("sessionStatus.approvalRequired") },
    { kind: "is-question", count: status.questions, text: String(status.questions), label: tr("sessionStatus.replyNeeded") },
    { kind: "is-result", count: status.results, text: countText(status.results), label: tr("sidebar.sessionlist.unreadActivity") },
    { kind: "is-working", count: status.working, text: String(status.working), label: tr("sessionStatus.working") },
  ].filter((line) => line.count > 0);
}

/** What a sighted pointer reads in the tooltip, for a screen reader. */
export function projectRailStatusLabel(name: string, status: ProjectRailStatus): string {
  return [name, ...statusLines(status).map((line) => `${line.label}: ${line.text}`)].join(". ");
}

export function ProjectRailStatusLines({ status }: { status: ProjectRailStatus }) {
  const lines = statusLines(status);
  if (lines.length === 0) return null;
  return (
    <span className="sidebar-project-rail-tooltip-status">
      {lines.map((line) => (
        <span key={line.kind} className="sidebar-project-rail-tooltip-line">
          <span className={`sidebar-project-rail-tooltip-swatch ${line.kind}`} />
          <span className="sidebar-project-rail-tooltip-count">{line.text}</span>
          <span className="sidebar-project-rail-tooltip-label">{line.label}</span>
        </span>
      ))}
    </span>
  );
}
