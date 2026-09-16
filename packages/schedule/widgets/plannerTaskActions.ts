import { api, type ScheduleTaskDto } from "@polyth/session/web-api";
import { setUiError } from "../../../apps/web/src/store.ts";
import { confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { duplicatePlannerTaskInput } from "../src/plannerTask.ts";
import { isLoopFile } from "./plannerShared.ts";

function fail(cause: unknown): false {
  setUiError(cause instanceof Error ? cause.message : String(cause));
  return false;
}

export async function runPlannerTask(taskId: string): Promise<boolean> {
  try {
    await api.scheduleRun(taskId);
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

export async function pausePlannerTask(taskId: string, pause: boolean): Promise<boolean> {
  try {
    await api.schedulePause(taskId, pause);
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

export async function duplicatePlannerTask(task: ScheduleTaskDto): Promise<boolean> {
  if (isLoopFile(task)) return false;
  const payload = duplicatePlannerTaskInput(task);
  if (!payload) return false;
  try {
    await api.scheduleCreate(payload);
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

export async function deletePlannerTask(task: ScheduleTaskDto): Promise<boolean> {
  if (isLoopFile(task)) return false;
  const ok = await confirmAlert(tr("scheduleview.deleteTaskConfirm"), {
    title: tr("scheduleview.deleteTask"),
    confirmLabel: tr("common.delete"),
    destructive: true,
  });
  if (!ok) return false;
  try {
    await api.scheduleDelete(task.id);
    return true;
  } catch (cause) {
    return fail(cause);
  }
}
