// Browser-safe Planner data model, shared by the server service, its routes
// and the widgets. No Node APIs here: widgets import this file directly.
import type { HarnessSelection, ModelRef } from "@polyth/contracts";

/** Event a run appends to its session before the prompt; settlement reads
 *  only what follows it, and the chat shows it as the run's timeline fact. */
export const PLANNER_RUN_STARTED_EVENT = "planner/run-started";

/** The agent tool an agent schedules into its own session with. */
export const PLANNER_TOOL_NAME = "polyth_planner";

export type PlannerKind = "at" | "every" | "cron";

export type PlannerCadence =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMinutes: number }
  | { kind: "cron"; expression: string; timeZone: string };

export type PlannerTargetMode = "existing-session" | "new-session-per-run" | "dedicated-session";

export interface PlannerTarget {
  mode: PlannerTargetMode;
  sessionId?: string;
  worktreePolicy?: "project-root" | "fresh-worktree";
}

/** Harness-qualified execution model chosen for a planned run. The harness may
 *  be absent on runtime-local catalogs; when present it is authoritative. */
export type PlannerExecutionModel = ModelRef & { harnessId?: string };

/** Execution route persisted with a task and replayed on every run. */
export interface PlannerExecutionSelection {
  model?: PlannerExecutionModel;
  harness?: HarnessSelection;
}

export type OverlapPolicy = "skip" | "queue" | "parallel";
/** What a run that fell due while Polyth was not running does on the first
 *  tick afterwards: fire once (marked late) or record a skip and wait for the
 *  next regular time. */
export type CatchUpPolicy = "once" | "skip";

/** `running` lasts until the admitted turn actually stops, not merely until the
 *  prompt was accepted. `unknown` means the outcome could not be confirmed
 *  (restart before admission, lost session, observation limit) — it is never
 *  guessed as success and never replayed. */
export type PlannerRunStatus = "running" | "ok" | "failed" | "skipped" | "unknown";

export interface PlannerRunRecord {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: PlannerRunStatus;
  error?: string;
  sessionId?: string;
  /** Seq of this run's `planner/run-started` event; settlement only reads
   *  the target session's events after it. */
  markerSeq?: number;
  /** Set when the prompt was queued behind other work in the session. */
  queueId?: string;
  turnId?: string;
  /** Fired after its due time passed while Polyth was not running. */
  late?: boolean;
  /** Started by a person ("Run now") rather than the clock. */
  manual?: boolean;
}

export interface PlannerRunSettlement {
  status: "ok" | "failed" | "unknown";
  error?: string;
}

export interface PlannerTask {
  id: string;
  projectId: string;
  /** Owning Space; decides which Space's storage persists the task. Absent
   *  only on tasks whose project could not be resolved yet. */
  spaceId?: string;
  /** The person who created the task. Its runs act for them, and stop once
   *  they leave the Space. Never edited. */
  ownerUserId?: string;
  /** Existing session to send into; omitted = create a fresh session per run. */
  sessionId?: string;
  title?: string;
  prompt: string;
  kind: PlannerKind;
  /** One-shot fire time (epoch ms) for kind "at". */
  at?: number;
  /** Interval for kind "every". */
  everyMinutes?: number;
  /** Source of truth for when the task fires (kind/at/everyMinutes mirror it). */
  cadence: PlannerCadence;
  target?: PlannerTarget;
  overlapPolicy?: OverlapPolicy;
  /** Absent = "once". */
  catchUp?: CatchUpPolicy;
  enabled: boolean;
  /** Harness/model to execute with. Absent = inherit the target session or
   *  the auto-resolved default. */
  model?: PlannerExecutionModel;
  harness?: HarnessSelection;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastError?: string;
  lastSessionId?: string;
  nextRunAt: number | null;
  runs: number;
  history?: PlannerRunRecord[];
}

export interface PlannerTaskInput {
  projectId: string;
  /** Owning Space of `projectId`; resolved through `spaceOf` when omitted. */
  spaceId?: string;
  /** Set by the server from the signed-in person on create; never taken
   *  from request input and ignored on update. */
  ownerUserId?: string;
  prompt: string;
  kind?: PlannerKind;
  at?: number;
  everyMinutes?: number;
  cadence?: PlannerCadence;
  target?: PlannerTarget;
  overlapPolicy?: OverlapPolicy;
  catchUp?: CatchUpPolicy;
  sessionId?: string;
  title?: string;
  enabled?: boolean;
  /** Explicit execution route; `null` clears a previously chosen route. */
  model?: PlannerExecutionModel | null;
  harness?: HarnessSelection | null;
}

export interface PlannerPreview {
  runs: number[];
  description: string;
}
