// Planner: prompts that run once or on a repeating cadence. JSON store per
// Space, in-process timer. The runner seam is injected: the server decides how
// a due task turns into a session message; this module never touches the
// agent runtime.
//
// Cron cadences carry an IANA time zone and share one code path between the
// preview and the executor. Runs keep a bounded history and follow the
// admitted turn to its real stop. Repository-managed `.agents/loops` files
// belong to the Agents package; the Planner never reads them, so one file can
// never fire twice.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessSelection, TurnAdmission } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import { describeCron, nextRun, nextRuns, validateCron } from "./cron.ts";
import type {
  PlannerCadence,
  PlannerExecutionSelection,
  PlannerPreview,
  PlannerRunRecord,
  PlannerRunSettlement,
  PlannerTask,
  PlannerTaskInput,
} from "./model.ts";

export * from "./model.ts";
export { describeCron, nextRun, nextRuns, validateCron } from "./cron.ts";
export { settlePlannedRun } from "./runSettlement.ts";
export type { RunSettlementOptions } from "./runSettlement.ts";

/** Event a run appends to its session before the prompt; settlement reads
 *  only what follows it. */
export const PLANNER_RUN_STARTED_EVENT = "planner/run-started";

/** A run acts for the task's owner; the session facade refuses the run if
 *  that person is no longer a member of the Space. */
export function plannerTurnAdmission(task: Pick<PlannerTask, "ownerUserId">): TurnAdmission | undefined {
  return task.ownerUserId ? { author: { userId: task.ownerUserId, via: "schedule" } } : undefined;
}

/** Resolve the send/create fields for one run. An explicit auto selection is
 *  never replayed: it would force an unattended harness re-resolution. When a
 *  model carries its own harness identity, that identity becomes the route. */
export function plannerExecutionSelection(
  task: Pick<PlannerTask, "model" | "harness">,
): PlannerExecutionSelection {
  const harness: HarnessSelection | undefined = task.harness?.mode === "pinned"
    ? task.harness
    : task.model?.harnessId
      ? { mode: "pinned", harnessId: task.model.harnessId }
      : undefined;
  return {
    ...(task.model ? { model: task.model } : {}),
    ...(harness ? { harness } : {}),
  };
}

/** What `run` learned at admission; persisted on the run record so the
 *  outcome can still be settled after a restart. */
export interface PlannerRunOutcome {
  sessionId?: string;
  markerSeq?: number;
  queueId?: string;
  turnId?: string;
}

export interface PlannerRunner {
  /** Admit the run (create/choose the session and submit the prompt).
   *  Resolves once the prompt is accepted, not when the agent finishes. */
  run(task: PlannerTask, runId: string): Promise<PlannerRunOutcome | void>;
  /** Resolve when the admitted turn has actually stopped. Rejecting after
   *  `signal` aborts leaves the run `running` for the next start() to resume.
   *  Without `settle`, admission is the outcome. */
  settle?(task: PlannerTask, run: PlannerRunRecord, signal: AbortSignal): Promise<PlannerRunSettlement>;
}

export interface PlannerServiceOptions {
  /** JSON file for tasks without a Space. Omit it with `spaceFile` and every
   *  task must belong to a Space (the server package keeps nothing in the
   *  shared data root). */
  file?: string;
  /** Per-Space document path. Every task with a `spaceId` persists there. */
  spaceFile?: (spaceId: string) => string;
  /** Spaces whose documents are read at construction. */
  spaceIds?: string[];
  /** Synchronous project → Space lookup for tasks created without one. */
  spaceOf?: (projectId: string) => string | undefined;
  runner: PlannerRunner;
  now?: () => number;
  /** Timer resolution for start(); due checks also run via tick(). */
  tickMs?: number;
  /** Fastest allowed cron cadence. */
  minCronIntervalMinutes?: number;
  /** A due time older than this when the tick sees it counts as missed. */
  missedGraceMs?: number;
}

export interface PlannerService {
  list(projectId?: string): PlannerTask[];
  get(id: string): PlannerTask | undefined;
  create(input: PlannerTaskInput): PlannerTask;
  update(id: string, patch: Partial<PlannerTaskInput>): PlannerTask;
  remove(id: string): boolean;
  setEnabled(id: string, enabled: boolean): PlannerTask;
  /** Fire a task immediately, ignoring its clock. */
  runNow(id: string): Promise<PlannerTask>;
  /** Run everything due; returns how many tasks fired. Timer + tests use this. */
  tick(): Promise<number>;
  /** Next-run preview through the SAME path the executor uses. */
  preview(cadence: PlannerCadence, count?: number): PlannerPreview;
  /** Bounded run history, newest first. */
  runsOf(id: string, limit?: number): PlannerRunRecord[];
  /** Attach Space ownership to tasks created before their project resolved;
   *  returns how many moved into a Space document. */
  assignSpaces(): number;
  /** Arms the timer and resumes settlement of runs left `running`. */
  start(): void;
  /** Disarms the timer and detaches settlement observers (runs stay `running`). */
  stop(): void;
}

const HISTORY_LIMIT = 50;
const DEFAULT_MISSED_GRACE_MS = 5 * 60_000;

const err = (message: string, code = "invalid-input"): Error =>
  Object.assign(new Error(message), { code });

/** Input → canonical cadence, accepting the flat kind/at/everyMinutes shape. */
function cadenceOf(input: PlannerTaskInput, minCronMinutes: number): PlannerCadence {
  if (input.cadence) {
    const c = input.cadence;
    if (c.kind === "at") {
      if (typeof c.at !== "number" || !Number.isFinite(c.at)) throw err("at (epoch ms) is required for one-shot tasks");
      return { kind: "at", at: c.at };
    }
    if (c.kind === "every") {
      if (typeof c.everyMinutes !== "number" || !Number.isFinite(c.everyMinutes) || c.everyMinutes < 1) {
        throw err("everyMinutes must be a finite number >= 1");
      }
      return { kind: "every", everyMinutes: c.everyMinutes };
    }
    if (c.kind === "cron") {
      const v = validateCron(c.expression ?? "", c.timeZone ?? "", { minIntervalMinutes: minCronMinutes });
      if (!v.ok) throw err(v.error!);
      return { kind: "cron", expression: c.expression.trim(), timeZone: c.timeZone };
    }
    throw err(`unknown cadence kind: ${String((c as { kind?: string }).kind)}`);
  }
  if (input.kind === "at") {
    if (typeof input.at !== "number" || !Number.isFinite(input.at)) throw err("at (epoch ms) is required for one-shot tasks");
    return { kind: "at", at: input.at };
  }
  if (input.kind === "every") {
    if (typeof input.everyMinutes !== "number" || !Number.isFinite(input.everyMinutes) || input.everyMinutes < 1) {
      throw err("everyMinutes must be a finite number >= 1");
    }
    return { kind: "every", everyMinutes: input.everyMinutes };
  }
  throw err(`unknown kind: ${String(input.kind)}`);
}

/** Mirror cadence back onto the flat fields older readers use. */
function mirrorCadence(t: PlannerTask): void {
  t.kind = t.cadence.kind;
  if (t.cadence.kind === "at") t.at = t.cadence.at;
  else delete t.at;
  if (t.cadence.kind === "every") t.everyMinutes = t.cadence.everyMinutes;
  else delete t.everyMinutes;
}

/** Next fire time. One-shots aim at their `at`; intervals run from the last
 *  run; cron next-run comes from the shared cron path (DST-deterministic). */
export function computeNextRun(
  task: Pick<PlannerTask, "cadence" | "enabled" | "lastRunAt" | "runs">,
  now: number,
): number | null {
  if (!task.enabled) return null;
  const c = task.cadence;
  if (c.kind === "at") return task.runs > 0 || !Number.isFinite(c.at) ? null : c.at;
  if (c.kind === "every") return (task.lastRunAt ?? now) + c.everyMinutes * 60_000;
  try {
    return nextRun(c.expression, c.timeZone, Math.max(task.lastRunAt ?? 0, now));
  } catch {
    return null; // an invalid cron cannot fire
  }
}

export function createPlannerService(opts: PlannerServiceOptions): PlannerService {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 15_000;
  const minCronMinutes = opts.minCronIntervalMinutes ?? 1;
  const missedGraceMs = opts.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (!opts.file && !opts.spaceFile) throw new Error("planner needs a file or a spaceFile");
  // Space-only: a task that cannot name its Space is refused, never parked.
  const spaceOnly = !opts.file;
  const shared = opts.file ? load(opts.file) : [];
  let tasks: PlannerTask[] = [];
  // Spaces that own a document; each one is rewritten on save so removing a
  // Space's last task empties its file instead of leaving it stale.
  const knownSpaces = new Set<string>();
  {
    // A Space document wins over the shared copy of the same task: a crash
    // between writing the Space file and rewriting the shared file leaves both.
    const byId = new Map<string, PlannerTask>();
    for (const spaceId of opts.spaceFile ? opts.spaceIds ?? [] : []) {
      knownSpaces.add(spaceId);
      // The document's location, not a field inside it, decides ownership.
      for (const t of load(opts.spaceFile!(spaceId))) byId.set(t.id, { ...t, spaceId });
    }
    for (const t of shared) if (!byId.has(t.id)) byId.set(t.id, t);
    tasks = [...byId.values()];
  }
  // task id -> in-flight run (admission through settlement); overlap policy consults it
  const running = new Map<string, Promise<void>>();
  // task ids that already have one successor waiting under the "queue" policy
  const queuedNext = new Set<string>();
  // run ids whose admission or settlement is in progress in this process
  const inFlight = new Set<string>();
  let observers = new AbortController();

  const writeDoc = (file: string, doc: Record<string, unknown>): void => {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify({ v: 1, ...doc }, null, 2));
  };

  const save = (): void => {
    if (!opts.spaceFile) {
      writeDoc(opts.file!, { tasks });
      return;
    }
    const groups = new Map<string | undefined, PlannerTask[]>();
    for (const spaceId of knownSpaces) groups.set(spaceId, []);
    for (const t of tasks) {
      const group = groups.get(t.spaceId) ?? [];
      group.push(t);
      groups.set(t.spaceId, group);
    }
    // Space documents first: the shared file only drops a task after its
    // Space copy is durable.
    for (const [spaceId, group] of groups) {
      if (spaceId === undefined) continue;
      knownSpaces.add(spaceId);
      writeDoc(opts.spaceFile(spaceId), { spaceId, tasks: group });
    }
    const rest = groups.get(undefined) ?? [];
    if (opts.file && (rest.length || existsSync(opts.file))) writeDoc(opts.file, { tasks: rest });
  };

  const assignSpaces = (): number => {
    let moved = 0;
    for (const t of tasks) {
      if (t.spaceId) continue;
      const spaceId = opts.spaceOf?.(t.projectId);
      if (!spaceId) continue;
      t.spaceId = spaceId;
      moved += 1;
    }
    if (moved && opts.spaceFile && opts.file && existsSync(opts.file)) {
      // Keep the pre-split shared document once, byte for byte.
      const backup = `${opts.file}.pre-space-split`;
      if (!existsSync(backup)) copyFileSync(opts.file, backup);
    }
    return moved;
  };
  if (assignSpaces() > 0) save();

  const mustGet = (id: string): PlannerTask => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw err("task not found", "not-found");
    return t;
  };

  const pushHistory = (t: PlannerTask, rec: PlannerRunRecord): void => {
    t.history = [rec, ...(t.history ?? [])].slice(0, HISTORY_LIMIT);
  };

  const finish = (task: PlannerTask, rec: PlannerRunRecord, result: PlannerRunSettlement): void => {
    rec.status = result.status;
    rec.finishedAt = now();
    if (result.error) rec.error = result.error;
    else delete rec.error;
    if (result.status === "ok") delete task.lastError;
    else task.lastError = rec.error ?? "The run's result could not be confirmed.";
    inFlight.delete(rec.runId);
    save();
  };

  /** Follow an admitted run to its real end. A stop() detaches the observer
   * without touching the record, so the next start() resumes it. */
  const observe = async (task: PlannerTask, rec: PlannerRunRecord): Promise<void> => {
    const signal = observers.signal;
    inFlight.add(rec.runId);
    try {
      const result = await opts.runner.settle!(task, { ...rec }, signal);
      if (signal.aborted) {
        inFlight.delete(rec.runId);
        return;
      }
      finish(task, rec, result);
    } catch (e) {
      if (signal.aborted) {
        inFlight.delete(rec.runId);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      finish(task, rec, { status: "unknown", error: `Could not confirm the run's result: ${message}` });
    }
  };

  /** `admitted` resolves once the prompt is accepted (or refused); `settled`
   * once the run's outcome is recorded. */
  const execute = (
    task: PlannerTask,
    late = false,
    manual = false,
  ): { admitted: Promise<void>; settled: Promise<void> } => {
    const runId = randomUUID();
    // Mark before running so a slow runner can never double-fire. A manual
    // run of a one-shot leaves its planned time armed.
    if (!manual) {
      task.lastRunAt = now();
      task.runs += 1;
      if (task.cadence.kind === "at") task.enabled = false;
      task.nextRunAt = computeNextRun(task, now());
    }
    task.updatedAt = now();
    const rec: PlannerRunRecord = {
      runId,
      startedAt: now(),
      status: "running",
      ...(late ? { late: true } : {}),
      ...(manual ? { manual: true } : {}),
    };
    pushHistory(task, rec);
    inFlight.add(runId);
    save();
    const admission = (async (): Promise<boolean> => {
      try {
        const outcome = await opts.runner.run(task, runId);
        if (outcome?.sessionId) {
          rec.sessionId = outcome.sessionId;
          task.lastSessionId = outcome.sessionId;
        }
        if (outcome?.markerSeq !== undefined) rec.markerSeq = outcome.markerSeq;
        if (outcome?.queueId) rec.queueId = outcome.queueId;
        if (outcome?.turnId) rec.turnId = outcome.turnId;
        if (!opts.runner.settle || !rec.sessionId) {
          finish(task, rec, { status: "ok" });
          return false;
        }
        // Admission cleared any earlier dispatch failure; the outcome is pending.
        delete task.lastError;
        save();
        return true;
      } catch (e) {
        finish(task, rec, { status: "failed", error: e instanceof Error ? e.message : String(e) });
        return false;
      }
    })();
    return {
      admitted: admission.then(() => {}),
      settled: admission.then((pending) => pending ? observe(task, rec) : undefined),
    };
  };

  const track = (taskId: string, run: Promise<void>): void => {
    const tracked: Promise<void> = run.catch(() => {}).finally(() => {
      if (running.get(taskId) === tracked) running.delete(taskId);
    });
    running.set(taskId, tracked);
  };

  const recordSkip = (task: PlannerTask, error: string): void => {
    pushHistory(task, {
      runId: randomUUID(), startedAt: now(), finishedAt: now(),
      status: "skipped", error,
    });
  };

  /** Fire honoring the overlap policy (default: skip while a run is active).
   * Resolves at admission; a run's own settlement never blocks the tick. */
  const fire = async (task: PlannerTask, late = false, manual = false): Promise<void> => {
    const policy = task.overlapPolicy ?? "skip";
    const active = running.get(task.id);
    if (active && (policy === "skip" || (policy === "queue" && queuedNext.has(task.id)))) {
      recordSkip(task, policy === "skip"
        ? "previous run still active (overlap policy: skip)"
        : "a run is already queued behind the active one (overlap policy: queue)");
      // Still advance the clock so a stuck run does not pile up due-fires.
      if (!manual) task.nextRunAt = computeNextRun({ ...task, lastRunAt: now() }, now());
      save();
      return;
    }
    if (active && policy === "queue") {
      queuedNext.add(task.id);
      track(task.id, active.then(() => {
        queuedNext.delete(task.id);
        return execute(task, late, manual).settled;
      }));
      return;
    }
    const run = execute(task, late, manual);
    track(task.id, run.settled);
    await run.admitted;
  };

  /** Due time passed long before this tick saw it: Polyth was not running. */
  const missedBy = (task: PlannerTask, at: number): boolean =>
    task.nextRunAt !== null && at - task.nextRunAt > missedGraceMs;

  const skipMissed = (task: PlannerTask, at: number): void => {
    recordSkip(task, "missed while Polyth was not running (catch-up: skip)");
    if (task.cadence.kind === "at") {
      task.enabled = false;
      task.nextRunAt = null;
    } else if (task.cadence.kind === "every") {
      task.nextRunAt = at + task.cadence.everyMinutes * 60_000;
    } else {
      task.nextRunAt = computeNextRun(task, at);
    }
    task.updatedAt = at;
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
      if (!input.projectId?.trim()) throw err("projectId is required");
      if (!input.prompt?.trim()) throw err("prompt is required");
      const cadence = cadenceOf(input, minCronMinutes);
      const spaceId = input.spaceId ?? opts.spaceOf?.(input.projectId);
      if (spaceOnly && !spaceId) throw err("project has no Space");
      const t: PlannerTask = {
        id: randomUUID(),
        projectId: input.projectId,
        prompt: input.prompt.trim(),
        kind: cadence.kind,
        cadence,
        enabled: input.enabled ?? true,
        createdAt: now(),
        updatedAt: now(),
        nextRunAt: null,
        runs: 0,
        ...(spaceId ? { spaceId } : {}),
        ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.target ? { target: input.target } : {}),
        ...(input.overlapPolicy ? { overlapPolicy: input.overlapPolicy } : {}),
        ...(input.catchUp ? { catchUp: input.catchUp } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
      };
      mirrorCadence(t);
      t.nextRunAt = computeNextRun(t, now());
      tasks.push(t);
      save();
      return t;
    },
    update(id, patch) {
      const t = mustGet(id);
      const merged: PlannerTaskInput = {
        projectId: patch.projectId ?? t.projectId,
        prompt: patch.prompt ?? t.prompt,
        ...(patch.cadence ? { cadence: patch.cadence } : { cadence: t.cadence }),
        sessionId: patch.sessionId ?? t.sessionId,
        title: patch.title ?? t.title,
        enabled: patch.enabled ?? t.enabled,
      };
      // Flat patches (kind/at/everyMinutes) override the carried cadence.
      if (patch.kind !== undefined || patch.at !== undefined || patch.everyMinutes !== undefined) {
        delete merged.cadence;
        merged.kind = patch.kind ?? t.kind;
        merged.at = patch.at ?? t.at;
        merged.everyMinutes = patch.everyMinutes ?? t.everyMinutes;
      }
      if (!merged.projectId?.trim()) throw err("projectId is required");
      if (!merged.prompt?.trim()) throw err("prompt is required");
      const cadence = cadenceOf(merged, minCronMinutes);
      if (merged.projectId !== t.projectId) {
        const spaceId = patch.spaceId ?? opts.spaceOf?.(merged.projectId);
        if (spaceOnly && !spaceId) throw err("project has no Space");
        if (spaceId) t.spaceId = spaceId;
        else delete t.spaceId;
      }
      t.projectId = merged.projectId;
      t.prompt = merged.prompt.trim();
      t.cadence = cadence;
      mirrorCadence(t);
      if (merged.sessionId !== undefined) t.sessionId = merged.sessionId;
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (title) t.title = title;
        else delete t.title;
      }
      if (patch.target !== undefined) {
        t.target = patch.target;
        if (patch.target.mode !== "existing-session") delete t.sessionId;
      }
      if (patch.overlapPolicy !== undefined) t.overlapPolicy = patch.overlapPolicy;
      if (patch.catchUp !== undefined) t.catchUp = patch.catchUp;
      if (patch.model !== undefined) {
        if (patch.model === null) delete t.model;
        else t.model = patch.model;
      }
      if (patch.harness !== undefined) {
        if (patch.harness === null) delete t.harness;
        else t.harness = patch.harness;
      }
      t.enabled = merged.enabled ?? true;
      if (cadence.kind === "at" && (patch.kind !== undefined || patch.at !== undefined || patch.cadence !== undefined)) {
        t.runs = 0; // re-arm one-shots on reschedule
      }
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
      if (enabled && t.cadence.kind === "at") t.runs = 0; // re-enable re-arms the one-shot
      t.nextRunAt = computeNextRun(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    async runNow(id) {
      const t = mustGet(id);
      await fire(t, false, true);
      return t;
    },
    async tick() {
      const t0 = now();
      const due = tasks.filter((t) => t.enabled && t.nextRunAt !== null && t.nextRunAt <= t0);
      let fired = 0;
      for (const t of due) {
        const late = missedBy(t, t0);
        if (late && t.catchUp === "skip") {
          skipMissed(t, t0);
          continue;
        }
        await fire(t, late);
        fired += 1;
      }
      return fired;
    },
    preview(cadence, count = 5) {
      const c = cadenceOf({ projectId: "x", prompt: "x", cadence }, minCronMinutes);
      const bounded = Math.max(1, Math.min(Math.trunc(count) || 5, 20));
      if (c.kind === "at") return { runs: [c.at], description: `Once, at ${new Date(c.at).toISOString()}` };
      if (c.kind === "every") {
        const t0 = now();
        return {
          runs: Array.from({ length: bounded }, (_, i) => t0 + (i + 1) * c.everyMinutes * 60_000),
          description: `Every ${c.everyMinutes} minute${c.everyMinutes === 1 ? "" : "s"}`,
        };
      }
      return {
        runs: nextRuns(c.expression, c.timeZone, now(), bounded),
        description: `${describeCron(c.expression)} (${c.timeZone})`,
      };
    },
    runsOf(id, limit = 50) {
      return (mustGet(id).history ?? []).slice(0, Math.max(1, Math.min(limit, HISTORY_LIMIT)));
    },
    assignSpaces() {
      const moved = assignSpaces();
      if (moved) save();
      return moved;
    },
    start() {
      if (timer) return;
      observers = new AbortController();
      // Runs left `running` by a previous process (or a previous enable):
      // resume following an admitted turn; a run that never confirmed its
      // admission cannot be followed and is never replayed.
      let changed = false;
      for (const t of tasks) {
        for (const rec of t.history ?? []) {
          if (rec.status !== "running" || inFlight.has(rec.runId)) continue;
          if (opts.runner.settle && rec.sessionId) {
            track(t.id, observe(t, rec));
          } else {
            rec.status = "unknown";
            rec.finishedAt = now();
            rec.error = "Polyth stopped before this run's result was confirmed.";
            t.lastError = rec.error;
            changed = true;
          }
        }
      }
      if (changed) save();
      timer = setInterval(() => {
        void this.tick().catch(() => {});
      }, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      observers.abort();
    },
  };
}

function load(file: string): PlannerTask[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tasks?: unknown };
    return Array.isArray(parsed.tasks)
      ? parsed.tasks.filter((t): t is PlannerTask =>
        !!t && typeof t === "object" && typeof (t as PlannerTask).id === "string" && !!(t as PlannerTask).cadence)
      : [];
  } catch {
    return [];
  }
}
