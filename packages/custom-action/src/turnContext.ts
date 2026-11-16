// Per-turn hint for the agent: which project actions are running right now, so
// it reuses them instead of starting a duplicate. Only the speaking person's
// runs (runs are private per person), same Space and project.
import type { TurnContextContributor } from "@polyth/plugins";
import type { RunManager } from "./runManager.ts";

export const MAX_RUNNING_LISTED = 8;
const clean = (value: string): string => value.replace(/[\r\n<>]+/g, " ").trim().slice(0, 60);

export function runningActionsContributor(deps: { runs(): RunManager | undefined; now?: () => number }): TurnContextContributor {
  const now = deps.now ?? Date.now;
  return ({ space, projectId, userId }) => {
    if (!userId) return "";
    const runs = deps.runs()?.running(space.spaceId, projectId, userId).slice(0, MAX_RUNNING_LISTED) ?? [];
    if (!runs.length) return "";
    const lines = runs.map((run) => {
      const minutes = Math.max(0, Math.floor((now() - run.startedAt) / 60_000));
      return `${clean(run.name) || "Action"} — running ${minutes}m${run.url ? ` — ${run.url}` : ""}`;
    });
    return ["<polyth-running-actions>", ...lines, "Reuse these instead of starting another copy; ask before stopping one.", "</polyth-running-actions>"].join("\n");
  };
}
