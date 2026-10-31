// What one action's icon shows right now. Pure: every surface derives the
// same state from the shared snapshot and a clock.
import type { ActionRunDto } from "../src/actionModel.ts";
import { actionKey, latestRun, type ActionsSnapshot, type Launch } from "./store.ts";

export type TileState = "idle" | "starting" | "running" | "chat" | "done" | "opened" | "failed";

export interface TileView {
  state: TileState;
  run?: ActionRunDto;
  launch?: Launch;
}

/** How long a success check stays on the icon. */
export const DONE_MS = 4_000;
/** How long a refused press keeps its error mark. */
export const LAUNCH_FAILED_MS = 10_000;
/** An unseen failure stops shouting after this long. */
export const FAILURE_MS = 15 * 60_000;

const failed = (run: ActionRunDto) => run.status === "failed" || run.status === "error" || run.status === "timed-out";

export function tileView(
  snapshot: Pick<ActionsSnapshot, "runs" | "launches" | "seen">,
  actionId: string,
  projectId: string | null,
  now: number,
): TileView {
  if (!projectId) return { state: "idle" };
  const launch = snapshot.launches[actionKey(actionId, projectId)];
  if (launch?.state === "starting") return { state: "starting", launch };
  const run = latestRun(snapshot.runs, actionId, projectId);
  if (launch && (!run || launch.at >= run.startedAt)) {
    if (launch.state === "opened" && now - launch.at < DONE_MS) return { state: "opened", launch, ...(run ? { run } : {}) };
    if (launch.state === "failed" && now - launch.at < LAUNCH_FAILED_MS) return { state: "failed", launch, ...(run ? { run } : {}) };
  }
  if (!run) return { state: "idle" };
  if (run.status === "running") return { state: run.phase === "chat" ? "chat" : "running", run };
  const age = now - (run.finishedAt ?? run.startedAt);
  if (failed(run) && !snapshot.seen.has(run.id) && age < FAILURE_MS) return { state: "failed", run };
  if (run.status === "succeeded" && age < DONE_MS) return { state: "done", run };
  return { state: "idle", run };
}

/** True while a view needs a clock tick to move on by itself. */
export const tileIsTransient = (view: TileView): boolean =>
  view.state === "running" || view.state === "chat" || view.state === "starting"
  || view.state === "done" || view.state === "opened" || (view.state === "failed" && !view.run);
