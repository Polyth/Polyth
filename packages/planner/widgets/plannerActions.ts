import type { PlannerTask } from "../src/model.ts";
import { setUiError } from "../../../apps/web/src/store.ts";
import { confirmAlert } from "../../../apps/web/src/components/ui/index.ts";
import { duplicatePlannerTaskInput } from "../src/plannerTask.ts";
import { taskDisplayTitle } from "../src/plannerList.ts";
import { plannerApi } from "./plannerApi.ts";
import { t } from "./plannerText.ts";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Report through the host's one transient error surface; never throws. */
async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (cause) {
    setUiError(message(cause));
    return undefined;
  }
}

export const runTask = (task: PlannerTask) => attempt(() => plannerApi.run(task.id));

export const setTaskPaused = (task: PlannerTask, paused: boolean) =>
  attempt(() => plannerApi.setPaused(task.id, paused));

export async function duplicateTask(task: PlannerTask): Promise<PlannerTask | undefined> {
  const input = duplicatePlannerTaskInput(task);
  if (!input) return undefined;
  return attempt(() => plannerApi.create({
    ...input,
    title: t("action.copySuffix", { title: taskDisplayTitle(task) }),
    enabled: false,
  }));
}

export async function deleteTask(task: PlannerTask): Promise<boolean> {
  const ok = await confirmAlert(t("action.deleteConfirm", { title: taskDisplayTitle(task) }), {
    title: t("action.deleteTitle"),
    confirmLabel: t("action.delete"),
    destructive: true,
  });
  if (!ok) return false;
  return (await attempt(() => plannerApi.remove(task.id)))?.ok === true;
}
