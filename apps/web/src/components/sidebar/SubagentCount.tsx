// The subagent disclosure pill's count, shared by the desktop session row and
// the phone navigator: "3" while every subagent is idle, "2/3" behind a
// pulsing accent dot while two of them work, and "1/3" behind a steady amber
// dot while one waits for a person (that outranks running work).
import { tr } from "../../i18n/index.ts";
import { subagentActivityTone, type SubagentActivity } from "../../subagentActivity.ts";

/** Accessible summary, e.g. "Subagents: 3, Working: 2, Waiting for you: 1". */
export function subagentActivityLabel(activity: SubagentActivity): string {
  return [
    tr("sidebar.sessionlist.subagentsCount", { count: activity.total }),
    activity.working > 0 ? tr("sidebar.sessionlist.subagentsWorking", { count: activity.working }) : "",
    activity.waiting > 0 ? tr("sidebar.sessionlist.subagentsWaiting", { count: activity.waiting }) : "",
  ].filter(Boolean).join(", ");
}

export function SubagentCount({ activity, className }: { activity: SubagentActivity; className: string }) {
  const tone = subagentActivityTone(activity);
  const shown = tone === "waiting" ? activity.waiting : activity.working;
  return (
    <>
      {tone && <span className={`subagent-activity-dot ${tone}`} aria-hidden="true" />}
      <span className={className} aria-hidden="true">{tone ? `${shown}/${activity.total}` : activity.total}</span>
    </>
  );
}
