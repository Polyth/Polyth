import type { ScheduleCadenceDto, ScheduleTaskDto } from "@polyth/session/web-api";

/** The task's cadence, accepting the legacy kind/at/everyMinutes shape. */
export function cadenceOfTask(task: Pick<ScheduleTaskDto, "cadence" | "kind" | "at" | "everyMinutes">): ScheduleCadenceDto | null {
  if (task.cadence) return task.cadence;
  if (task.kind === "at" && typeof task.at === "number") return { kind: "at", at: task.at };
  if (task.kind === "every" && typeof task.everyMinutes === "number") {
    return { kind: "every", everyMinutes: task.everyMinutes };
  }
  return null;
}
