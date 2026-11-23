// The island's quiet tally: how the open chat's delegation has gone in the
// current episode (since the person's latest message), not lifetime totals.
import type { SessionProjection } from "@polyth/contracts";
import type { RenderModel } from "./reduce.ts";

export interface SubagentTally {
  done: number;
  failed: number;
  /** The first failed child, for the clickable count. */
  firstFailedId?: string;
}

/** Children (never forks: `children` is the parent's delegated list) that
 *  settled after the parent's latest user message began. `active` says a child
 *  still runs, waits or is paused, so it is not settled. */
export function subagentTally(
  children: readonly SessionProjection[],
  model: Pick<RenderModel, "messages">,
  active: (child: SessionProjection) => boolean,
): SubagentTally {
  let episodeStart = 0;
  for (const message of model.messages) {
    if (message.kind === "user" && message.time > episodeStart) episodeStart = message.time;
  }
  const tally: SubagentTally = { done: 0, failed: 0 };
  for (const child of children) {
    if (child.forkOf || active(child) || child.updatedAt < episodeStart) continue;
    if (child.status === "failed") {
      tally.failed += 1;
      tally.firstFailedId ??= child.id;
    } else if (child.status === "idle") tally.done += 1;
  }
  return tally;
}
