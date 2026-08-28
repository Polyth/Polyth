import type { MultirunRunDto, MultirunRunStatus } from "@polyth/contracts";

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
