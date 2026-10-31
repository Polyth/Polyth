// One-line descriptions of an agent's state and rhythm, shared by its page,
// the overview and the editor.
import type { ScheduleTaskDto } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import { fmtSessionElapsed } from "../../../apps/web/src/format.ts";
import { clockOf } from "../src/agentHeartbeat.ts";
import { formatWake, trippedLine } from "./agentTime.ts";
import type { AgentLive } from "./agentLive.ts";

/** "every 30 min", "every 2 h". */
export function intervalLabel(minutes: number): string {
  return minutes % 60 === 0 ? tr("agents.everyHoursValue", { count: minutes / 60 }) : tr("agents.everyMinutesValue", { count: minutes });
}

/** What the agent does next, in one line: its rhythm and the next wake. */
export function rhythmLine(task: ScheduleTaskDto, live: AgentLive): string {
  const parts: string[] = [];
  // The next scheduled run, even when a heartbeat comes sooner.
  if (live.nextWake && !task.manualOnly && typeof task.nextRunAt === "number") {
    parts.push(tr("agents.nextValue", { when: formatWake(task.nextRunAt) }));
  }
  if (task.heartbeat) {
    const hours = task.heartbeat.activeFrom !== undefined && task.heartbeat.activeTo !== undefined
      ? ` ${clockOf(task.heartbeat.activeFrom)}–${clockOf(task.heartbeat.activeTo)}`
      : "";
    parts.push(`${tr("agents.heartbeatShortValue", { interval: intervalLabel(task.heartbeat.everyMinutes) })}${hours}`);
  }
  if (!parts.length) parts.push(task.eventTriggers?.length ? tr("agents.onEvents") : tr("agents.onDemand"));
  else if (task.eventTriggers?.length) parts.push(tr("agents.onEventsShort"));
  return parts.join(" · ");
}

function phaseLine(task: ScheduleTaskDto, live: AgentLive, now: number, short: boolean): string {
  switch (live.phase) {
    case "review": return tr("agents.reviewNeeded");
    case "needs-you": return live.waiting.length > 1
      ? tr("agents.waitingForYouValue", { count: live.waiting.length })
      : tr("agents.waitingForYou");
    case "stopped": return short ? tr("agents.stateTripped") : trippedLine(task);
    // The same clock as the agent's row and its live dock.
    case "working": return tr("agents.workingForValue", { duration: fmtSessionElapsed(now - live.running!.startedAt) });
    case "paused": return tr("agents.statePaused");
    case "draft": return tr("agents.draftHint");
    default: return rhythmLine(task, live);
  }
}

/** The agent's state as a line of its own, sentence-cased: rhythm pieces
 *  ("checks every 30 min") read as fragments inside a sentence.
 *  `short`: a notice beside the line already says why the agent stopped. */
export function statusLine(task: ScheduleTaskDto, live: AgentLive, now = Date.now(), short = false): string {
  const line = phaseLine(task, live, now, short);
  return line.charAt(0).toLocaleUpperCase(getLocale()) + line.slice(1);
}
