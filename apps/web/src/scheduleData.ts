import type { ScheduleListResponseDto, ScheduleLoopErrorDto, ScheduleTaskDto } from "./api.ts";

export interface NormalizedScheduleList {
  tasks: ScheduleTaskDto[];
  loopErrors: ScheduleLoopErrorDto[];
}

function scheduleTasks(value: unknown): ScheduleTaskDto[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (task): task is ScheduleTaskDto =>
      typeof task === "object" &&
      task !== null &&
      typeof (task as { id?: unknown }).id === "string",
  );
}

function loopErrors(value: unknown): ScheduleLoopErrorDto[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (error): error is ScheduleLoopErrorDto =>
      typeof error === "object" &&
      error !== null &&
      typeof (error as { path?: unknown }).path === "string" &&
      typeof (error as { error?: unknown }).error === "string",
  );
}

/** Accept both the current array response and older wrapped schedule payloads. */
export function normalizeScheduleList(value: ScheduleListResponseDto | unknown): NormalizedScheduleList {
  if (Array.isArray(value)) return { tasks: scheduleTasks(value), loopErrors: [] };
  if (typeof value !== "object" || value === null) return { tasks: [], loopErrors: [] };

  const wrapped = value as { tasks?: unknown; loopErrors?: unknown; errors?: unknown };
  return {
    tasks: scheduleTasks(wrapped.tasks),
    loopErrors: loopErrors(wrapped.loopErrors ?? wrapped.errors),
  };
}
