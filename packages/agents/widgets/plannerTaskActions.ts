import { api, type ScheduleTaskDto } from "@polyth/session/web-api";
import { setUiError } from "../../../apps/web/src/store.ts";
import { confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

function fail(cause: unknown): false {
  setUiError(cause instanceof Error ? cause.message : String(cause));
  return false;
}

export async function reviewLoopVersion(
  taskId: string,
  action: "trust-current" | "run-once" | "reject",
): Promise<boolean> {
  try {
    const res = await fetch(`/api/schedule/${encodeURIComponent(taskId)}/trust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const payload = await res.json() as { message?: unknown; error?: unknown };
        if (typeof payload.message === "string") message = payload.message;
        else if (typeof payload.error === "string") message = payload.error;
      } catch { /* use bounded generic transport error */ }
      throw new Error(message);
    }
    return true;
  } catch (cause) {
    return fail(cause);
  }
}

export async function deletePlannerTask(task: ScheduleTaskDto): Promise<boolean> {
  if (task.source === "loop-file") return false;
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
