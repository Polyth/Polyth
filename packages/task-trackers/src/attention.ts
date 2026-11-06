import type { TaskTrackerAgentStopReceipt, TaskTrackerTaskLinkDto } from "./types.ts";

/**
 * Which linked tasks an agent has stopped on and nobody has looked at yet.
 *
 * Pure, browser-safe rules: the board derives the card edge and the order from
 * the link index the server already keeps, so nothing here needs a second
 * source of truth. A stop is "not looked at yet" while it is newer than the
 * last time that task was opened here (`seenAt`, Space-wide like the index).
 */

/** The key the board's link map uses for a task. */
export const agentTaskRef = (task: { provider: string; id: string }): string =>
  `${task.provider}:${task.id}`;

export function groupLinksByTask(
  links: readonly TaskTrackerTaskLinkDto[],
): Map<string, TaskTrackerTaskLinkDto[]> {
  const grouped = new Map<string, TaskTrackerTaskLinkDto[]>();
  for (const link of links) {
    const key = `${link.provider}:${link.taskId}`;
    grouped.set(key, [...grouped.get(key) ?? [], link]);
  }
  return grouped;
}

/** The newest stop of any of these links that nobody has looked at yet. */
export function unseenAgentStop(
  links: readonly TaskTrackerTaskLinkDto[],
): TaskTrackerAgentStopReceipt | undefined {
  let newest: TaskTrackerAgentStopReceipt | undefined;
  for (const link of links) {
    const stop = link.agentStop;
    if (!stop) continue;
    if (stop.at <= (link.seenAt ?? 0)) continue;
    if (!newest || stop.at > newest.at) newest = stop;
  }
  return newest;
}

export const hasUnseenAgentStop = (links: readonly TaskTrackerTaskLinkDto[]): boolean =>
  unseenAgentStop(links) !== undefined;

/**
 * Tasks with an unseen agent stop first — the newest stop at the very top —
 * then everything else in the order it was given. Stable, so a board that
 * loads the same data twice does not shuffle.
 */
export function byAgentAttention<T>(
  tasks: readonly T[],
  linksOf: (task: T) => readonly TaskTrackerTaskLinkDto[],
): T[] {
  const ranked = tasks.map((task, index) => ({
    task,
    index,
    stop: unseenAgentStop(linksOf(task)),
  }));
  const attended = ranked.filter((row) => row.stop !== undefined);
  if (attended.length === 0) return [...tasks];
  attended.sort((left, right) => (right.stop!.at - left.stop!.at) || left.index - right.index);
  const rest = ranked.filter((row) => row.stop === undefined);
  return [...attended, ...rest].map((row) => row.task);
}
