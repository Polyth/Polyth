// Scheduled prompts (polyth scheduled-tasks parity + WP10). JSON store
// under the data dir, in-process timer. The runner seam is injected: the
// server decides how a due task turns into a session message; this package
// never touches the agent runtime.
//
// WP10 adds: cron cadence with IANA time zones (preview and executor share
// one code path), explicit run targets with bounded history, overlap policy,
// and reconciliation of Markdown-managed loops from .agents/loops.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteSync } from "@polyth/plugins";
import {
  contentTrustMatches,
  issueContentTrustReceipt,
  type ContentTrustReceipt,
  type ContentTrustSubject,
} from "@polyth/permissions";
import { describeCron, nextRun, nextRuns, validateCron } from "./cron.ts";
import type { LoopFileResult } from "./loops.ts";

export { describeCron, nextRun, nextRuns, validateCron } from "./cron.ts";
export { parseLoopFile, scanLoopsDir } from "./loops.ts";
export type { LoopFileResult, LoopSpec } from "./loops.ts";

export type ScheduleKind = "at" | "every" | "cron";

export type ScheduleCadence =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMinutes: number }
  | { kind: "cron"; expression: string; timeZone: string };

export interface ScheduleTarget {
  mode: "existing-session" | "new-session-per-run" | "dedicated-session";
  sessionId?: string;
  worktreePolicy?: "project-root" | "fresh-worktree";
}

export type OverlapPolicy = "skip" | "queue" | "parallel";
export type LoopTrustState = "untrusted" | "trusted-current-version" | "changed-since-trust";

/** Visible metadata for repository content awaiting a trust decision. The
 * unapproved executable prompt is intentionally not duplicated into this
 * record; approval re-reads the repository and validates this digest. */
export interface PendingLoopVersion {
  sourceDigest: string;
  semanticDigest: string;
  changedFields: string[];
  observedAt: number;
}

export interface ScheduleRunRecord {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "ok" | "failed" | "skipped";
  error?: string;
  sessionId?: string;
}

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
  /** Source of truth for when the task fires (legacy fields mirror it). */
  cadence: ScheduleCadence;
  target?: ScheduleTarget;
  overlapPolicy?: OverlapPolicy;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastError?: string;
  lastSessionId?: string;
  nextRunAt: number | null;
  runs: number;
  history?: ScheduleRunRecord[];
  /** Managed-loop provenance (WP10 §3). UI-created tasks are "ui". */
  source?: "ui" | "loop-file";
  sourcePath?: string;
  /** Current observed repository digest, whether trusted or not. */
  sourceDigest?: string;
  parseError?: string;
  loopId?: string;
  /** Pause on a file-managed task overrides the file's enabled flag locally. */
  enabledOverride?: boolean;
  agentProfile?: string;
  /** Authorization for the exact executable snapshot currently stored in
   * prompt/cadence/title/agentProfile. */
  trustReceipt?: ContentTrustReceipt;
  trustState?: LoopTrustState;
  pendingVersion?: PendingLoopVersion;
  rejectedSourceDigest?: string;
}

export interface ScheduleTaskInput {
  projectId: string;
  prompt: string;
  kind?: ScheduleKind;
  at?: number;
  everyMinutes?: number;
  cadence?: ScheduleCadence;
  target?: ScheduleTarget;
  overlapPolicy?: OverlapPolicy;
  sessionId?: string;
  title?: string;
  enabled?: boolean;
}

export interface ScheduleRunOutcome {
  sessionId?: string;
}

export interface ScheduleRunner {
  run(task: ScheduleTask, runId: string): Promise<ScheduleRunOutcome | void>;
}

export interface ScheduleServiceOptions {
  /** JSON file path, e.g. `${dataDir}/schedule.json`. */
  file: string;
  runner: ScheduleRunner;
  now?: () => number;
  /** Timer resolution for start(); due checks also run via tick(). */
  tickMs?: number;
  /** Fastest allowed cron cadence. */
  minCronIntervalMinutes?: number;
}

export interface SchedulePreview {
  runs: number[];
  description: string;
}

/** Persisted .agents/loops scan diagnostic (UX-FIXTURE-VISUAL P1): survives
 *  list refreshes and restarts until a later scan proves the file valid or
 *  the user explicitly dismisses it. */
export interface ScheduleLoopError {
  path: string;
  error: string;
  firstSeenAt: number;
  lastSeenAt: number;
  dismissed?: boolean;
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
  /** Next-run preview through the SAME path the executor uses. */
  preview(cadence: ScheduleCadence, count?: number): SchedulePreview;
  /** Bounded run history, newest first. */
  runsOf(id: string, limit?: number): ScheduleRunRecord[];
  /** Reconcile .agents/loops scan results with managed tasks. An explicit
   *  (user-requested) rescan clears dismissals so fresh diagnostics show. */
  syncLoops(projectId: string, scan: LoopFileResult[], opts?: { explicit?: boolean }): { tasks: ScheduleTask[]; errors: Array<{ path: string; error: string }> };
  /** Promote exactly the current repository version to executable state. */
  trustLoopVersion(id: string, spaceId: string, file: LoopFileResult): ScheduleTask;
  /** Execute exactly the current version once without granting persistent trust. */
  runLoopVersionOnce(id: string, spaceId: string, file: LoopFileResult): Promise<ScheduleTask>;
  /** Record an explicit decision to keep this version blocked. */
  rejectLoopVersion(id: string): ScheduleTask;
  /** Visible (non-dismissed) persisted scan diagnostics. */
  loopErrors(projectId?: string): Array<{ path: string; error: string }>;
  /** Hide one diagnostic until its error text changes on a later scan. */
  dismissLoopError(projectId: string, path: string): boolean;
  start(): void;
  stop(): void;
}

const HISTORY_LIMIT = 50;

const err = (message: string, code = "invalid-input"): Error =>
  Object.assign(new Error(message), { code });

/** Input → canonical cadence, accepting legacy kind/at/everyMinutes. */
function cadenceOf(input: ScheduleTaskInput, minCronMinutes: number): ScheduleCadence {
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
  // legacy shape
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

/** Mirror cadence back onto the legacy fields the existing UI/API read. */
function mirrorCadence(t: ScheduleTask): void {
  t.kind = t.cadence.kind;
  if (t.cadence.kind === "at") t.at = t.cadence.at;
  if (t.cadence.kind === "every") t.everyMinutes = t.cadence.everyMinutes;
}

const loopExecutableShape = (loop: NonNullable<LoopFileResult["loop"]>) => ({
  title: loop.title,
  cadence: { kind: "cron" as const, expression: loop.cron, timeZone: loop.timeZone },
  enabled: loop.enabled,
  agentProfile: loop.agentProfile ?? null,
  prompt: loop.prompt,
});

export function loopSemanticDigest(loop: NonNullable<LoopFileResult["loop"]>): string {
  return createHash("sha256").update(JSON.stringify(loopExecutableShape(loop))).digest("hex");
}

function applyLoopExecutable(task: ScheduleTask, loop: NonNullable<LoopFileResult["loop"]>): void {
  task.prompt = loop.prompt;
  task.cadence = { kind: "cron", expression: loop.cron, timeZone: loop.timeZone };
  task.title = loop.title;
  if (loop.agentProfile) task.agentProfile = loop.agentProfile;
  else delete task.agentProfile;
  mirrorCadence(task);
}

function changedLoopFields(
  task: ScheduleTask,
  loop: NonNullable<LoopFileResult["loop"]>,
  sourcePath: string,
): string[] {
  const fields: string[] = [];
  if (task.sourcePath && task.sourcePath !== sourcePath) fields.push("sourcePath");
  if (task.prompt !== loop.prompt) fields.push("prompt");
  if (task.title !== loop.title) fields.push("title");
  if (task.cadence.kind !== "cron"
    || task.cadence.expression !== loop.cron
    || task.cadence.timeZone !== loop.timeZone) fields.push("schedule");
  if ((task.agentProfile ?? "") !== (loop.agentProfile ?? "")) fields.push("agentProfile");
  return fields;
}

function trustSubject(task: Pick<ScheduleTask, "projectId">, file: LoopFileResult, spaceId: string): ContentTrustSubject {
  if (!file.loop || !file.digest) throw err("loop version is not executable", "content-trust-changed");
  return {
    spaceId,
    projectId: task.projectId,
    sourceKind: "agents-loop",
    sourceIdentity: file.path,
    contentDigest: file.digest,
    semanticDigest: loopSemanticDigest(file.loop),
  };
}

/** Final dispatch-time guard. Git status/diffs are deliberately irrelevant:
 * external edits, pulls, checkouts, merges and rebases all reduce to the bytes
 * currently on disk and therefore the content/semantic digests below. */
export function assertLoopExecutionTrusted(
  task: ScheduleTask,
  file: LoopFileResult | undefined,
  spaceId: string,
): void {
  if (task.source !== "loop-file") return;
  if (!file?.loop || !task.sourcePath || file.path !== task.sourcePath || file.digest !== task.sourceDigest) {
    throw err("Loop content changed since approval. Refresh and review the current version.", "content-trust-changed");
  }
  if (!contentTrustMatches(task.trustReceipt, trustSubject(task, file, spaceId))) {
    throw err("Loop content is not trusted for this exact version.", "content-trust-required");
  }
}

function observedPending(
  file: LoopFileResult,
  observedAt: number,
  changedFields: string[],
): PendingLoopVersion {
  return {
    sourceDigest: file.digest,
    semanticDigest: file.loop ? loopSemanticDigest(file.loop) : "",
    changedFields: changedFields.length ? changedFields : ["content"],
    observedAt,
  };
}

/** Next fire time. One-shots aim at their `at`; intervals run from the last
 *  run; cron next-run comes from the shared cron path (DST-deterministic). */
export function computeNextRun(
  task: Pick<ScheduleTask, "cadence" | "enabled" | "lastRunAt" | "runs">,
  now: number,
): number | null {
  if (!task.enabled) return null;
  const c = task.cadence;
  if (c.kind === "at") return task.runs > 0 || !Number.isFinite(c.at) ? null : c.at;
  if (c.kind === "every") return (task.lastRunAt ?? now) + c.everyMinutes * 60_000;
  try {
    return nextRun(c.expression, c.timeZone, Math.max(task.lastRunAt ?? 0, now));
  } catch {
    return null; // invalid cron cannot fire; parseError surfaces the reason
  }
}

export function createScheduleService(opts: ScheduleServiceOptions): ScheduleService {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 15_000;
  const minCronMinutes = opts.minCronIntervalMinutes ?? 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  const persisted = load(opts.file);
  let tasks: ScheduleTask[] = persisted.tasks;
  // projectId -> persisted scan diagnostics (survive refresh + restart)
  const loopErrorsByProject: Record<string, ScheduleLoopError[]> = persisted.loopErrors;
  // task id -> in-flight run promise (overlap policy consults this)
  const running = new Map<string, Promise<void>>();

  // One-time migration. Pre-content-trust managed tasks are never grandfathered
  // into execution merely because their old path/digest record exists.
  let migrated = false;
  for (const t of tasks) {
    if (!t.cadence) {
      t.cadence = t.kind === "at"
        ? { kind: "at", at: t.at ?? 0 }
        : { kind: "every", everyMinutes: t.everyMinutes ?? 1 };
      migrated = true;
    }
    if (t.source === "loop-file" && !t.trustReceipt) {
      t.trustState = "untrusted";
      t.enabled = false;
      t.nextRunAt = null;
      migrated = true;
    }
  }

  const save = (): void => {
    mkdirSync(dirname(opts.file), { recursive: true });
    atomicWriteSync(opts.file, JSON.stringify({ v: 3, tasks, loopErrors: loopErrorsByProject }, null, 2));
  };
  if (migrated) save();

  const mustGet = (id: string): ScheduleTask => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw err("task not found", "not-found");
    return t;
  };

  const pushHistory = (t: ScheduleTask, rec: ScheduleRunRecord): void => {
    t.history = [rec, ...(t.history ?? [])].slice(0, HISTORY_LIMIT);
  };

  /** `task` owns canonical history/clock state; `executableTask` may be an
   * exact one-shot repository snapshot which must never replace canonical
   * approved prompt/cadence fields. */
  const execute = async (task: ScheduleTask, executableTask: ScheduleTask = task): Promise<void> => {
    const runId = randomUUID();
    // Mark before running so a slow runner can never double-fire.
    task.lastRunAt = now();
    task.runs += 1;
    if (task.cadence.kind === "at") task.enabled = false;
    task.nextRunAt = computeNextRun(task, now());
    task.updatedAt = now();
    const rec: ScheduleRunRecord = { runId, startedAt: now(), status: "running" };
    pushHistory(task, rec);
    save();
    try {
      const outcome = await opts.runner.run(executableTask, runId);
      rec.status = "ok";
      rec.finishedAt = now();
      if (outcome?.sessionId) {
        rec.sessionId = outcome.sessionId;
        task.lastSessionId = outcome.sessionId;
      }
      delete task.lastError;
    } catch (e) {
      rec.status = "failed";
      rec.finishedAt = now();
      rec.error = e instanceof Error ? e.message : String(e);
      task.lastError = rec.error;
    }
    save();
  };

  /** Fire honoring the overlap policy (default: skip while a run is active). */
  const fire = async (task: ScheduleTask, executableTask: ScheduleTask = task): Promise<void> => {
    const policy = task.overlapPolicy ?? "skip";
    const active = running.get(task.id);
    if (active && policy === "skip") {
      pushHistory(task, {
        runId: randomUUID(), startedAt: now(), finishedAt: now(),
        status: "skipped", error: "previous run still active (overlap policy: skip)",
      });
      // Still advance the clock so a stuck run does not pile up due-fires.
      task.nextRunAt = computeNextRun({ ...task, lastRunAt: now() }, now());
      save();
      return;
    }
    const start = active && policy === "queue" ? active.catch(() => {}) : Promise.resolve();
    const p = start.then(() => execute(task, executableTask)).finally(() => {
      if (running.get(task.id) === p) running.delete(task.id);
    });
    running.set(task.id, p);
    if (policy !== "parallel") await p;
    else await Promise.resolve(); // parallel: fire-and-track
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
      const t: ScheduleTask = {
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
        source: "ui",
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.target ? { target: input.target } : {}),
        ...(input.overlapPolicy ? { overlapPolicy: input.overlapPolicy } : {}),
      };
      mirrorCadence(t);
      t.nextRunAt = computeNextRun(t, now());
      tasks.push(t);
      save();
      return t;
    },
    update(id, patch) {
      const t = mustGet(id);
      if (t.source === "loop-file") {
        if (patch.prompt !== undefined || patch.cadence !== undefined || patch.kind !== undefined
          || patch.at !== undefined || patch.everyMinutes !== undefined || patch.title !== undefined) {
          throw err(`this task is managed by ${t.sourcePath ?? "a loop file"}; edit the file instead`, "conflict");
        }
        if (patch.enabled === true && t.trustState !== "trusted-current-version") {
          throw err("trust the current loop version before activating it", "content-trust-required");
        }
        if (patch.enabled !== undefined) t.enabledOverride = patch.enabled;
      }
      const merged: ScheduleTaskInput = {
        projectId: patch.projectId ?? t.projectId,
        prompt: patch.prompt ?? t.prompt,
        ...(patch.cadence ? { cadence: patch.cadence } : { cadence: t.cadence }),
        sessionId: patch.sessionId ?? t.sessionId,
        title: patch.title ?? t.title,
        enabled: patch.enabled ?? t.enabled,
      };
      // Legacy patches (kind/at/everyMinutes) override the carried cadence.
      if (patch.kind !== undefined || patch.at !== undefined || patch.everyMinutes !== undefined) {
        delete merged.cadence;
        merged.kind = patch.kind ?? t.kind;
        merged.at = patch.at ?? t.at;
        merged.everyMinutes = patch.everyMinutes ?? t.everyMinutes;
      }
      if (!merged.projectId?.trim()) throw err("projectId is required");
      if (!merged.prompt?.trim()) throw err("prompt is required");
      const cadence = cadenceOf(merged, minCronMinutes);
      t.projectId = merged.projectId;
      t.prompt = merged.prompt.trim();
      t.cadence = cadence;
      mirrorCadence(t);
      if (merged.sessionId !== undefined) t.sessionId = merged.sessionId;
      if (merged.title !== undefined) t.title = merged.title;
      if (patch.target !== undefined) t.target = patch.target;
      if (patch.overlapPolicy !== undefined) t.overlapPolicy = patch.overlapPolicy;
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
      if (t.source === "loop-file") {
        if (enabled && t.trustState !== "trusted-current-version") {
          throw err("trust the current loop version before activating it", "content-trust-required");
        }
        // Local override; the file's enabled flag stays authoritative on disk.
        t.enabledOverride = enabled;
      }
      t.enabled = enabled;
      if (enabled && t.cadence.kind === "at") t.runs = 0; // re-enable re-arms the one-shot
      t.nextRunAt = computeNextRun(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    async runNow(id) {
      const t = mustGet(id);
      if (t.source === "loop-file" && t.trustState !== "trusted-current-version") {
        throw err("this repository-managed loop version is blocked pending trust", "content-trust-required");
      }
      await fire(t);
      return t;
    },
    async tick() {
      const t0 = now();
      const due = tasks.filter((t) => t.enabled && !t.parseError
        && (t.source !== "loop-file" || t.trustState === "trusted-current-version")
        && t.nextRunAt !== null && t.nextRunAt <= t0);
      for (const t of due) await fire(t);
      return due.length;
    },
    preview(cadence, count = 5) {
      const c = cadenceOf({ projectId: "x", prompt: "x", cadence }, minCronMinutes);
      if (c.kind === "at") return { runs: [c.at], description: `Once, at ${new Date(c.at).toISOString()}` };
      if (c.kind === "every") {
        const t0 = now();
        return {
          runs: Array.from({ length: count }, (_, i) => t0 + (i + 1) * c.everyMinutes * 60_000),
          description: `Every ${c.everyMinutes} minute${c.everyMinutes === 1 ? "" : "s"}`,
        };
      }
      return {
        runs: nextRuns(c.expression, c.timeZone, now(), count),
        description: `${describeCron(c.expression)} (${c.timeZone})`,
      };
    },
    runsOf(id, limit = 50) {
      return (mustGet(id).history ?? []).slice(0, Math.max(1, Math.min(limit, HISTORY_LIMIT)));
    },
    syncLoops(projectId, scan, syncOpts) {
      const errors: Array<{ path: string; error: string }> = [];
      const seenIds = new Set<string>();
      for (const file of scan) {
        if (!file.loop) {
          if (file.parseError) {
            errors.push({ path: file.path, error: file.parseError });
            // A broken file keeps its existing last-approved task/history but
            // changed bytes immediately invalidate execution.
            const existing = tasks.find((t) => t.projectId === projectId && t.source === "loop-file" && t.sourcePath === file.path);
            if (existing) {
              existing.parseError = file.parseError;
              if (existing.loopId) seenIds.add(existing.loopId);
              if (file.digest && file.digest !== existing.sourceDigest) {
                existing.sourceDigest = file.digest;
                existing.trustState = existing.trustReceipt ? "changed-since-trust" : "untrusted";
                existing.pendingVersion = observedPending(file, now(), ["content"]);
                existing.enabled = false;
                existing.nextRunAt = null;
                existing.updatedAt = now();
              }
            }
          }
          continue;
        }
        const loop = file.loop;
        seenIds.add(loop.id);
        let t = tasks.find((x) => x.projectId === projectId && x.source === "loop-file" && x.loopId === loop.id);
        if (!t) {
          t = {
            id: randomUUID(),
            projectId,
            prompt: loop.prompt,
            kind: "cron",
            cadence: { kind: "cron", expression: loop.cron, timeZone: loop.timeZone },
            enabled: false,
            createdAt: now(),
            updatedAt: now(),
            nextRunAt: null,
            runs: 0,
            source: "loop-file",
            sourcePath: file.path,
            sourceDigest: file.digest,
            loopId: loop.id,
            trustState: "untrusted",
            pendingVersion: observedPending(file, now(), ["initialVersion"]),
            ...(loop.agentProfile ? { agentProfile: loop.agentProfile } : {}),
            ...(loop.title ? { title: loop.title } : {}),
          };
          mirrorCadence(t);
          tasks.push(t);
          continue;
        }

        const fields = changedLoopFields(t, loop, file.path);
        const currentSubject: ContentTrustSubject = {
          spaceId: t.trustReceipt?.spaceId ?? "__untrusted__",
          projectId,
          sourceKind: "agents-loop",
          sourceIdentity: file.path,
          contentDigest: file.digest,
          semanticDigest: loopSemanticDigest(loop),
        };
        const trustedCurrent = !!t.trustReceipt
          && contentTrustMatches(t.trustReceipt, currentSubject, "current-version");

        t.sourcePath = file.path;
        t.sourceDigest = file.digest;
        delete t.parseError;

        if (trustedCurrent) {
          // Rehydrating from exact approved bytes is safe and repairs stale
          // persisted projections without broadening authorization.
          applyLoopExecutable(t, loop);
          t.trustState = "trusted-current-version";
          delete t.pendingVersion;
          delete t.rejectedSourceDigest;
          t.enabled = t.enabledOverride ?? loop.enabled;
          t.nextRunAt = computeNextRun(t, now());
        } else {
          // Before the first approval there is no trusted snapshot to preserve,
          // so current parsed content may be displayed. Once a receipt exists,
          // repository changes NEVER replace that executable snapshot.
          if (!t.trustReceipt) applyLoopExecutable(t, loop);
          t.trustState = t.trustReceipt ? "changed-since-trust" : "untrusted";
          t.pendingVersion = observedPending(file, now(), fields);
          if (t.rejectedSourceDigest !== file.digest) delete t.rejectedSourceDigest;
          t.enabled = false;
          t.nextRunAt = null;
        }
        t.updatedAt = now();
      }
      // Managed tasks whose file/id vanished: preserve the existing explicit
      // remove policy. Changed files above retain the last approved history.
      tasks = tasks.filter((t) =>
        !(t.projectId === projectId && t.source === "loop-file" && t.loopId && !seenIds.has(t.loopId)));
      // Persist diagnostics: a clean scan clears them, an identical error
      // keeps its firstSeenAt (and dismissal, unless the rescan was explicit).
      const prevErrors = loopErrorsByProject[projectId] ?? [];
      loopErrorsByProject[projectId] = errors.map((e) => {
        const old = prevErrors.find((p) => p.path === e.path && p.error === e.error);
        return {
          path: e.path,
          error: e.error,
          firstSeenAt: old?.firstSeenAt ?? now(),
          lastSeenAt: now(),
          ...(old?.dismissed && !syncOpts?.explicit ? { dismissed: true } : {}),
        };
      });
      save();
      return {
        tasks: tasks.filter((t) => t.projectId === projectId && t.source === "loop-file"),
        errors,
      };
    },
    trustLoopVersion(id, spaceId, file) {
      const t = mustGet(id);
      if (t.source !== "loop-file" || !t.loopId || !t.sourcePath || !file.loop) {
        throw err("task is not a valid repository-managed loop", "invalid-input");
      }
      if (file.path !== t.sourcePath || file.loop.id !== t.loopId
        || !file.digest || file.digest !== t.sourceDigest) {
        throw err("loop changed again; refresh and review the current version", "content-trust-changed");
      }
      t.trustReceipt = issueContentTrustReceipt(trustSubject(t, file, spaceId), "current-version", now());
      applyLoopExecutable(t, file.loop);
      t.trustState = "trusted-current-version";
      delete t.pendingVersion;
      delete t.rejectedSourceDigest;
      delete t.parseError;
      t.enabled = t.enabledOverride ?? file.loop.enabled;
      t.updatedAt = now();
      t.nextRunAt = computeNextRun(t, now());
      save();
      return t;
    },
    async runLoopVersionOnce(id, spaceId, file) {
      const t = mustGet(id);
      if (t.source !== "loop-file" || !t.loopId || !t.sourcePath || !file.loop) {
        throw err("task is not a valid repository-managed loop", "invalid-input");
      }
      if (file.path !== t.sourcePath || file.loop.id !== t.loopId
        || !file.digest || file.digest !== t.sourceDigest) {
        throw err("loop changed again; refresh and review the current version", "content-trust-changed");
      }
      const executable: ScheduleTask = {
        ...t,
        prompt: file.loop.prompt,
        title: file.loop.title,
        cadence: { kind: "cron", expression: file.loop.cron, timeZone: file.loop.timeZone },
        kind: "cron",
        enabled: true,
        sourceDigest: file.digest,
        trustReceipt: issueContentTrustReceipt(trustSubject(t, file, spaceId), "once", now()),
        trustState: "trusted-current-version",
        ...(file.loop.agentProfile ? { agentProfile: file.loop.agentProfile } : {}),
      };
      if (!file.loop.agentProfile) delete executable.agentProfile;
      await fire(t, executable);
      // Persistent authorization and executable fields remain exactly as they
      // were before this one-shot execution.
      t.enabled = false;
      t.nextRunAt = null;
      save();
      return t;
    },
    rejectLoopVersion(id) {
      const t = mustGet(id);
      if (t.source !== "loop-file" || !t.sourceDigest) {
        throw err("task is not a repository-managed loop", "invalid-input");
      }
      t.rejectedSourceDigest = t.sourceDigest;
      t.enabled = false;
      t.nextRunAt = null;
      t.updatedAt = now();
      save();
      return t;
    },
    loopErrors(projectId) {
      const all = projectId
        ? loopErrorsByProject[projectId] ?? []
        : Object.values(loopErrorsByProject).flat();
      return all.filter((e) => !e.dismissed).map((e) => ({ path: e.path, error: e.error }));
    },
    dismissLoopError(projectId, path) {
      const e = (loopErrorsByProject[projectId] ?? []).find((x) => x.path === path && !x.dismissed);
      if (!e) return false;
      e.dismissed = true;
      save();
      return true;
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

function load(file: string): { tasks: ScheduleTask[]; loopErrors: Record<string, ScheduleLoopError[]> } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      tasks?: ScheduleTask[];
      loopErrors?: Record<string, ScheduleLoopError[]>;
    };
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      loopErrors: parsed.loopErrors && typeof parsed.loopErrors === "object" ? parsed.loopErrors : {},
    };
  } catch {
    return { tasks: [], loopErrors: {} };
  }
}
