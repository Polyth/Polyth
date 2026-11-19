import { createHash } from "node:crypto";
import type { RuntimeBackgroundTask, SessionNativeBackgroundTasks, SessionProjection } from "@polyth/contracts";

/** Bounds for what a runtime may store on a projection. */
const TASKS_MAX = 32;
const ID_MAX = 200;
const DESCRIPTION_MAX = 300;
const KIND_MAX = 64;

/** A harness's background task list, as far as it can be trusted: unique,
 *  non-empty ids and bounded text. Anything else is dropped. */
export const normalizeBackgroundTasks = (value: unknown): RuntimeBackgroundTask[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tasks: RuntimeBackgroundTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim().slice(0, ID_MAX) : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const description = typeof raw.description === "string" ? raw.description.trim().slice(0, DESCRIPTION_MAX) : "";
    const kind = typeof raw.kind === "string" ? raw.kind.trim().slice(0, KIND_MAX) : "";
    tasks.push({ id, ...(description ? { description } : {}), ...(kind ? { kind } : {}) });
    if (tasks.length >= TASKS_MAX) break;
  }
  return tasks;
};

/** `base` followed by every task of `more` it does not already name. */
export const mergeBackgroundTasks = (
  base: readonly RuntimeBackgroundTask[],
  more: readonly RuntimeBackgroundTask[],
): RuntimeBackgroundTask[] => {
  const ids = new Set(base.map((task) => task.id));
  return [...base, ...more.filter((task) => !ids.has(task.id))].slice(0, TASKS_MAX);
};

/** The projection with `state` as its background-task record, or without the
 *  record when nothing in it is still owed. */
export const withNativeBackgroundTasks = (
  projection: SessionProjection,
  state: SessionNativeBackgroundTasks,
): SessionProjection => {
  const next: SessionNativeBackgroundTasks = {};
  if (state.tasks?.length) {
    next.tasks = state.tasks;
    next.since = state.since ?? Date.now();
    if (state.orphanedAt !== undefined) next.orphanedAt = state.orphanedAt;
  }
  if (state.lost?.tasks.length) next.lost = state.lost;
  const { nativeBackgroundTasks: _previous, ...rest } = projection;
  return next.tasks || next.lost ? { ...rest, nativeBackgroundTasks: next } : rest;
};

/** Identity of one loss notice: the same lost tasks always map to the same
 *  wake, so a retry after a failed or uncertain send cannot run it twice. */
export const lostBackgroundTasksWakeId = (lost: NonNullable<SessionNativeBackgroundTasks["lost"]>): string =>
  createHash("sha256")
    .update(`background-tasks-lost\0${lost.at}\0${lost.tasks.map((task) => task.id).sort().join("\0")}`)
    .digest("hex")
    .slice(0, 32);

/** The hidden prompt that tells the agent its background work will never
 *  report back. */
export const lostBackgroundTasksText = (lost: NonNullable<SessionNativeBackgroundTasks["lost"]>): string => [
  `The process that ran your background work ended before that work reported back (${lost.reason}).`,
  "These tasks stopped with it and no completion notice will ever arrive for them:",
  ...lost.tasks.map((task) => `- ${task.description ? `${task.description} ` : ""}(task ${task.id}${task.kind ? `, ${task.kind}` : ""})`),
  "",
  "Check what they managed to produce (output files may be incomplete), run again whatever is still needed, and continue your task.",
].join("\n");
