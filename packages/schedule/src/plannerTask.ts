import type { ScheduleCadenceDto, ScheduleTargetDto, ScheduleTaskDto, ScheduleTaskInputDto } from "@polyth/session/web-api";

export type PlannerCadenceLike = {
  kind?: string;
  cadence?: { kind?: string } | null;
};

export function isOnceCadence(task: PlannerCadenceLike): boolean {
  if (task.cadence?.kind === "at") return true;
  return task.kind === "at";
}

/** Finished one-shot: no future fire. Engine disables after the run; leftovers may still be enabled. */
export function isCompletedOnce(task: PlannerCadenceLike & {
  enabled: boolean;
  nextRunAt: number | null;
  runs?: number;
}): boolean {
  if (!isOnceCadence(task) || task.nextRunAt !== null) return false;
  if ((task.runs ?? 0) > 0) return true;
  return task.enabled;
}

export function plannerRowShowsActiveSwitch(
  task: PlannerCadenceLike & { enabled: boolean; nextRunAt: number | null },
): boolean {
  return !isCompletedOnce(task);
}

export function cadenceOfTask(task: Pick<ScheduleTaskDto, "cadence" | "kind" | "at" | "everyMinutes">): ScheduleCadenceDto | null {
  if (task.cadence) return task.cadence;
  if (task.kind === "at" && typeof task.at === "number") return { kind: "at", at: task.at };
  if (task.kind === "every" && typeof task.everyMinutes === "number") {
    return { kind: "every", everyMinutes: task.everyMinutes };
  }
  return null;
}

export function plannerTaskTarget(task: Pick<ScheduleTaskDto, "target" | "sessionId">): ScheduleTargetDto | undefined {
  if (task.target) return task.target;
  if (task.sessionId) return { mode: "existing-session", sessionId: task.sessionId };
  return undefined;
}

export function sessionIdAfterProjectChange(
  sessionId: string,
  targetMode: string,
  sessionsInProject: readonly { id: string }[],
): string {
  if (targetMode !== "existing-session") return "";
  if (!sessionId) return "";
  return sessionsInProject.some((session) => session.id === sessionId) ? sessionId : "";
}

export function existingSessionTargetValid(
  targetMode: string,
  sessionId: string,
  sessionsInProject: readonly { id: string }[],
): boolean {
  if (targetMode !== "existing-session") return true;
  return sessionsInProject.some((session) => session.id === sessionId);
}

export function canSubmitPlannerEditor(input: {
  projectId: string;
  prompt: string;
  cadenceOk: boolean;
  targetMode: string;
  sessionId: string;
  sessionsInProject: readonly { id: string }[];
  isEdit?: boolean;
  dirty?: boolean;
}): boolean {
  if (!input.projectId || !input.prompt.trim() || !input.cadenceOk) return false;
  if (!existingSessionTargetValid(input.targetMode, input.sessionId, input.sessionsInProject)) return false;
  if (input.isEdit && input.dirty === false) return false;
  return true;
}

export function duplicatePlannerTaskInput(task: ScheduleTaskDto): ScheduleTaskInputDto | null {
  const cadence = cadenceOfTask(task);
  if (!cadence) return null;
  const target = plannerTaskTarget(task);
  return {
    projectId: task.projectId,
    prompt: task.prompt,
    cadence,
    ...(task.title ? { title: task.title } : {}),
    ...(target ? { target } : {}),
    overlapPolicy: task.overlapPolicy ?? "skip",
    enabled: task.enabled,
  };
}
