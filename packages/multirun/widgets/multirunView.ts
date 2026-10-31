import type { JsonObject, MultirunRunDto, MultirunRunStatus } from "@polyth/contracts";
import type { MultirunRunScoreFields } from "../src/rubric.ts";

export type {
  ScoredMultirunDto,
  ScoredMultirunRun,
} from "../src/rubric.ts";

export interface MultirunSummary {
  total: number;
  finished: number;
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  cost?: number;
}

export function summarizeMultirun(runs: readonly MultirunRunDto[]): MultirunSummary {
  const count = (status: MultirunRunStatus) =>
    runs.filter((run) => run.status === status).length;
  const completed = count("completed");
  const failed = count("failed");
  const cost = runs.reduce((total, run) => total + (run.cost ?? 0), 0);
  return {
    total: runs.length,
    finished: completed + failed,
    running: count("running"),
    waiting: count("pending"),
    completed,
    failed,
    ...(cost > 0 ? { cost } : {}),
  };
}

export function multirunDuration(
  run: Pick<MultirunRunDto, "startedAt" | "finishedAt">,
  now: number,
): number | null {
  if (run.startedAt === undefined) return null;
  return Math.max(0, (run.finishedAt ?? now) - run.startedAt);
}

export function preferredRunId(
  runs: readonly MultirunRunDto[],
  current?: string,
): string {
  if (current && runs.some((run) => run.id === current)) return current;
  return runs.find((run) => run.status === "running")?.id
    ?? runs.find((run) => run.status === "completed")?.id
    ?? runs[0]?.id
    ?? "";
}

/**
 * Rebuilds per-run score fields from `multirun/run-scored` events. The live
 * server snapshot already carries them; the canonical event log is the source
 * of truth after a reload, so the view merges these for the log-derived path.
 */
export function scoreFieldsFromEvents(
  events: readonly { type: string; data?: JsonObject }[],
  multirunId: string,
): Record<string, MultirunRunScoreFields> {
  const fields: Record<string, MultirunRunScoreFields> = {};
  for (const event of events) {
    if (event.type !== "multirun/run-scored") continue;
    const data = (event.data ?? {}) as JsonObject;
    if (typeof data.multirunId !== "string" || data.multirunId !== multirunId) continue;
    const runId = typeof data.runId === "string" ? data.runId : "";
    if (!runId) continue;
    const score = typeof data.score === "number" ? data.score : undefined;
    const confidence = typeof data.confidence === "number" ? data.confidence : undefined;
    const levels = typeof data.levels === "number" ? data.levels : undefined;
    const note = typeof data.note === "string" ? data.note : undefined;
    fields[runId] = {
      ...(score !== undefined ? { score } : {}),
      ...(confidence !== undefined ? { scoreConfidence: confidence } : {}),
      ...(levels !== undefined ? { scoreLevels: levels } : {}),
      ...(note ? { scoreNote: note } : {}),
    };
  }
  return fields;
}
