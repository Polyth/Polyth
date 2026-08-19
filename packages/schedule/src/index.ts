// Scheduled prompts (polyth scheduled-tasks parity). JSON store under the
// data dir, in-process timer. The runner seam is injected: the server decides
// how a due task turns into a session message; this package never touches the
// agent runtime.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type ScheduleKind = "at" | "every";

export interface ScheduleTask {
  id: string;
  projectId: string;
  /** Existing session to send into; omitted = create a fresh session per run. */
  sessionId?: string;
  title?: string;
  prompt: string;
  kind: ScheduleKind;
  /** One-shot fire time (epoch ms) for kind "at". */
  at?: number;
  /** Interval for kind "every". */
  everyMinutes?: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastError?: string;
  nextRunAt: number | null;
  runs: number;
}

export interface ScheduleTaskInput {
  projectId: string;
  prompt: string;
  kind: ScheduleKind;
  at?: number;
  everyMinutes?: number;
  sessionId?: string;
  title?: string;
  enabled?: boolean;
}

export interface ScheduleRunner {
  run(task: ScheduleTask): Promise<void>;
}

export interface ScheduleServiceOptions {
  /** JSON file path, e.g. `${dataDir}/schedule.json`. */
  file: string;
  runner: ScheduleRunner;
  now?: () => number;
  /** Timer resolution for start(); due checks also run via tick(). */
  tickMs?: number;
}

export interface ScheduleService {
  list(projectId?: string): ScheduleTask[];
  get(id: string): ScheduleTask | undefined;
  create(input: ScheduleTaskInput): ScheduleTask;
  update(id: string, patch: Partial<ScheduleTaskInput>): ScheduleTask;
  remove(id: string): boolean;
  setEnabled(id: string, enabled: boolean): ScheduleTask;
  /** Fire a task immediately, ignoring its clock. */
  runNow(id: string): Promise<ScheduleTask>;
  /** Run everything due; returns how many tasks fired. Timer + tests use this. */
  tick(): Promise<number>;
  start(): void;
  stop(): void;
}

const err = (message: string, code = "invalid-input"): Error =>
  Object.assign(new Error(message), { code });

function validate(input: ScheduleTaskInput): void {
  if (!input.projectId?.trim()) throw err("projectId is required");
  if (!input.prompt?.trim()) throw err("prompt is required");
  if (input.kind === "at") {
    if (typeof input.at !== "number" || !Number.isFinite(input.at)) throw err("at (epoch ms) is required for one-shot tasks");
  } else if (input.kind === "every") {
    if (typeof input.everyMinutes !== "number" || !Number.isFinite(input.everyMinutes) || input.everyMinutes < 1) {
      throw err("everyMinutes must be a finite number >= 1");
    }
  } else {
    throw err(`unknown kind: ${String(input.kind)}`);
  }
}

/** Next fire time. One-shots aim at their `at`; intervals run from the last run. */
export function computeNextRun(task: Pick<ScheduleTask, "kind" | "at" | "everyMinutes" | "enabled" | "lastRunAt" | "runs">, now: number): number | null {
  if (!task.enabled) return null;
  if (task.kind === "at") return task.runs > 0 ? null : (task.at ?? null);
  const base = task.lastRunAt ?? now;
  return base + (task.everyMinutes ?? 1) * 60_000;
}

export function createScheduleService(opts: ScheduleServiceOptions): ScheduleService {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 15_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tasks: ScheduleTask[] = load(opts.file);

  const save = (): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(opts.file, JSON.stringify({ v: 1, tasks }, null, 2));
  };

  const mustGet = (id: string): ScheduleTask => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw err("task not found", "not-found");
    return t;
  };

  const fire = async (task: ScheduleTask): Promise<void> => {
    // Mark before running so a slow runner can never double-fire.
    task.lastRunAt = now();
    task.runs += 1;
    if (task.kind === "at") task.enabled = false;
    task.nextRunAt = computeNextRun(task, now());
    task.updatedAt = now();
    save();
    try {
      await opts.runner.run(task);
      delete task.lastError;
    } catch (e) {
      task.lastError = e instanceof Error ? e.message : String(e);
    }
    save();
  };

  return {
    list(projectId) {
      const all = [...tasks].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
      return projectId ? all.filter((t) => t.projectId === projectId) : all;
    },
    get(id) {
      return tasks.find((t) => t.id === id);
    },
    create(input) {
      validate(input);
      const t: ScheduleTask = {
        id: randomUUID(),
        projectId: input.projectId,
        prompt: input.prompt.trim(),
        kind: input.kind,
        enabled: input.enabled ?? true,
        createdAt: now(),
        updatedAt: now(),
        nextRunAt: null,
        runs: 0,
        ...(input.at !== undefined ? { at: input.at } : {}),
        ...(input.everyMinutes !== undefined ? { everyMinutes: input.everyMinutes } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
      };
      t.nextRunAt = computeNextRun(t, now());
      tasks.push(t);
      save();
      return t;
    },
    update(id, patch) {
      const t = mustGet(id);
      const merged: ScheduleTaskInput = {
        projectId: patch.projectId ?? t.projectId,
        prompt: patch.prompt ?? t.prompt,
        kind: patch.kind ?? t.kind,
        at: patch.at ?? t.at,
        everyMinutes: patch.everyMinutes ?? t.everyMinutes,
        sessionId: patch.sessionId ?? t.sessionId,
        title: patch.title ?? t.title,
        enabled: patch.enabled ?? t.enabled,
      };
      validate(merged);
      t.projectId = merged.projectId;
      t.prompt = merged.prompt.trim();
      t.kind = merged.kind;
      if (merged.at !== undefined) t.at = merged.at;
      if (merged.everyMinutes !== undefined) t.everyMinutes = merged.everyMinutes;
      if (merged.sessionId !== undefined) t.sessionId = merged.sessionId;
      if (merged.title !== undefined) t.title = merged.title;
      t.enabled = merged.enabled ?? true;
      if (patch.kind === "at" || patch.at !== undefined) t.runs = 0; // re-arm one-shots on reschedule
      t.nextRunAt = computeNextRun(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    remove(id) {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      if (tasks.length !== before) save();
      return tasks.length !== before;
    },
    setEnabled(id, enabled) {
      const t = mustGet(id);
      t.enabled = enabled;
      if (enabled && t.kind === "at") t.runs = 0; // re-enable re-arms the one-shot
      t.nextRunAt = computeNextRun(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    async runNow(id) {
      const t = mustGet(id);
      await fire(t);
      return t;
    },
    async tick() {
      const t0 = now();
      const due = tasks.filter((t) => t.enabled && t.nextRunAt !== null && t.nextRunAt <= t0);
      for (const t of due) await fire(t);
      return due.length;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function load(file: string): ScheduleTask[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tasks?: ScheduleTask[] };
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}
