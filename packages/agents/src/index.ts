// Scheduled prompts. JSON store
// under the data dir, in-process timer. The runner seam is injected: the
// server decides how a due task turns into a session message; this package
// never touches the agent runtime.
//
// Also: cron cadence with IANA time zones (preview and executor share
// one code path), explicit run targets with bounded history, overlap policy,
// and reconciliation of Markdown-managed loops from .agents/loops.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AttachmentRef, HarnessSelection, ModelRef, TokenUsage, TurnAdmission } from "@polyth/contracts";
import { atomicWriteSync } from "@polyth/plugins";
import {
  contentTrustMatches,
  issueContentTrustReceipt,
  type ContentTrustReceipt,
  type ContentTrustSubject,
} from "@polyth/permissions";
import { describeCron, nextRun, nextRuns, validateCron } from "./cron.ts";
import type { LoopFileResult } from "./loops.ts";
import { fallbacksFromFile, fallbacksToFile, type AgentFileSpec } from "./agentFile.ts";
import { budgetExceeded, failureStreakReached, pendingFeedback, type AgentTrigger, type AgentWake } from "./agentPrompt.ts";
import { computeNextBeat, validateHeartbeat, type AgentHeartbeat } from "./agentHeartbeat.ts";
import {
  appendToNotebook,
  headlineFrom,
  NOTEBOOK_LIMIT,
  parseAgentReport,
  type AgentNotifyPolicy,
  type AgentSignal,
} from "./agentReport.ts";
import {
  describeEvent,
  DEFAULT_PACE,
  MAX_CHAIN_DEPTH,
  MAX_EVENT_TRIGGERS,
  nextChainDepth,
  offerEvent,
  settlePace,
  triggerMatches,
  validateTrigger,
  type AgentEvent,
  type AgentEventTrigger,
  type PaceState,
} from "./agentEvents.ts";
import { AGENT_INPUT_LIMIT, type AgentContinuation, type AgentFreshReason, type ThreadTarget } from "./agentThread.ts";

export * from "./agentEvents.ts";
export * from "./agentHeartbeat.ts";
export * from "./agentReport.ts";
export * from "./agentSession.ts";
export * from "./agentThread.ts";

export {
  budgetExceeded,
  composeAgentPrompt,
  estimateTokens,
  failureStreakReached,
  journalNotes,
  pendingFeedback,
  spendInLastDay,
  DEFAULT_ROTATE_AT,
} from "./agentPrompt.ts";
export type { AgentSpend, AgentTrigger, AgentWake } from "./agentPrompt.ts";
export { describeCron, nextRun, nextRuns, validateCron } from "./cron.ts";
export { parseLoopFile, scanLoopsDir } from "./loops.ts";
export type { LoopFileResult, LoopSpec } from "./loops.ts";
export { settleScheduledRun } from "./runSettlement.ts";
export type { RunSettlementOptions } from "./runSettlement.ts";

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

/** Harness-qualified execution model chosen for a planned run. The harness may
 *  be absent on runtime-local catalogs; when present it is authoritative. */
export type ScheduleExecutionModel = ModelRef & { harnessId?: string };

/** Execution route persisted with a task and replayed on every run. */
export interface ScheduleExecutionSelection {
  model?: ScheduleExecutionModel;
  harness?: HarnessSelection;
}

/** Backup routes an agent may use, in priority order. */
export const MAX_FALLBACK_MODELS = 8;

/** How much an agent's sessions may do without asking a person: ask for
 *  everything, approve routine requests, or Full access. Absent = the
 *  session's inherited default. Maps onto the session auto-accept setting. */
export type AgentPermissionLevel = "ask" | "routine" | "all";
export const AGENT_PERMISSION_LEVELS: readonly AgentPermissionLevel[] = ["ask", "routine", "all"];

export type OverlapPolicy = "skip" | "queue" | "parallel";
/** What a run that fell due while Polyth was not running does on the first
 *  tick afterwards: fire once (marked late) or record a skip and wait for the
 *  next regular time. */
export type CatchUpPolicy = "once" | "skip";
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

/** `running` lasts until the admitted turn actually stops, not merely until the
 *  prompt was accepted. `unknown` means the outcome could not be confirmed
 *  (restart before admission, lost session, observation limit) — it is never
 *  guessed as success and never replayed. */
export type ScheduleRunStatus = "running" | "ok" | "failed" | "skipped" | "unknown";

export interface ScheduleRunRecord {
  runId: string;
  startedAt: number;
  finishedAt?: number;
  status: ScheduleRunStatus;
  error?: string;
  sessionId?: string;
  /** Seq of this run's `schedule/run-started` event; settlement only reads
   *  the target session's events after it. */
  markerSeq?: number;
  /** Set when the prompt was queued behind other work in the session. */
  queueId?: string;
  turnId?: string;
  /** Fired after its due time passed while Polyth was not running. */
  late?: boolean;
  /** What woke the agent. Absent on runs recorded before agents. */
  trigger?: AgentTrigger;
  /** The person's words (only theirs). */
  input?: string;
  /** Event wakes: the wake script's note. It may quote event data, so it is
   *  never shown or treated as the person's words. Records from before
   *  schema 5 kept it in `input`; loading moves it here once. */
  note?: string;
  /** Journal note: the agent's final message of this run, bounded. Derived
   *  from the session's canonical events, never a source of truth. */
  summary?: string;
  /** Usage summed from the run's `usage/recorded` events. */
  tokens?: TokenUsage;
  cost?: number;
  /** Why a rolling agent started a new session for this run. */
  rotated?: "instructions-changed" | "context-full" | "compacted";
  /** Event wakes: one line per event that started this run. */
  events?: string[];
  /** How many agent hops led here (event wakes only); capped at MAX_CHAIN_DEPTH. */
  chainDepth?: number;
  /** Approval requests in this run's session that wait for a person. */
  waiting?: AgentWaitingRequest[];
  /** What the run's report says it amounts to. Absent on failed, unknown and
   *  legacy runs; an answer without a Report line counts as an update. */
  signal?: AgentSignal;
  /** One line from the report (or the answer's first line). */
  headline?: string;
  /** Notes this run added to the notebook. */
  remembered?: string[];
  /** The person's verdict on this run's report. */
  feedback?: AgentRunFeedback;
  /** The person stopped this run: not a failure of the agent. */
  stopped?: boolean;
  /** 1-based position of the backup model that served the run, when the
   *  main model could not. */
  backup?: number;
  /** `rollingKeyOf` of the task when this run's session started: the
   *  current key for a new session, the earlier run's key when it continued. */
  key?: string;
  /** The run went on in a session an earlier run already used: the rolling
   *  conversation, or the exchange the person's message follows up. */
  continued?: boolean;
  /** The run carried the person's words (or rotated a rolling agent) yet
   *  started a new session: why. */
  fresh?: AgentFreshReason;
  /** Files the person attached to the message that started this run. */
  attachments?: AgentRunAttachment[];
  /** While running: the newest step the agent took, read from its session. */
  activity?: AgentRunActivity;
  /** Tool steps the run's turn took (distinct tool calls). */
  steps?: number;
}

/** What a run record keeps of one attachment: enough to show it. */
export interface AgentRunAttachment {
  name: string;
  mime: string;
  size: number;
  kind?: "file" | "image";
  /** Project-relative path of the uploaded copy (under `_inbox/`). */
  path?: string;
}

/** A run's newest step. `tool`: the tool and a bounded copy of its input;
 *  `text`/`thinking`: the newest line the agent wrote. */
export interface AgentRunActivity {
  kind: "tool" | "text" | "thinking";
  /** Stable for one step (its tool call or message part) while its words
   *  grow; a new step has a new id. */
  id?: string;
  /** When the step began. */
  at: number;
  tool?: string;
  input?: Record<string, string | number | boolean>;
  text?: string;
}

/** A message from the person waiting for the run in progress. */
export interface AgentQueuedMessage {
  text: string;
  at: number;
  /** How many files came with it. */
  attachments?: number;
  /** The person's explicit choice of conversation, when they made one. */
  continuation?: Exclude<AgentContinuation, "auto">;
  /** The conversation the waiting run goes on in, fixed when it queued
   *  (`RunStart.thread`); absent = a new one. */
  sessionId?: string;
}

export interface AgentRunFeedback {
  verdict: "up" | "down";
  /** What to do differently, in the person's words. Data for the agent. */
  note?: string;
  at: number;
  /** A later run's prompt carried it. */
  delivered?: boolean;
}

export interface AgentWaitingRequest {
  requestId: string;
  kind: "permission" | "question";
  /** What is asked, e.g. the permission and its patterns. Data, not instructions. */
  title: string;
  since: number;
}

/** What a person-less approval request does once it has waited `timeoutMinutes`. */
export interface AgentApprovalPolicy {
  timeoutMinutes: number;
  /** wait: keep waiting (you are notified); reject: deny it and let the run
   *  continue; stop: stop the run. */
  onTimeout: "wait" | "reject" | "stop";
}

export interface AgentEventLogEntry {
  at: number;
  triggerId: string;
  outcome: "fired" | "rate-limited" | "chain-limit" | "budget" | "busy" | "overlap"
    | "script-skip" | "script-pause" | "script-error";
  /** Number of events behind this entry. */
  count: number;
  text?: string;
}

export type WakeScriptResult =
  | { ok: true; decision: { action: "run"; note?: string } | { action: "skip" | "pause"; reason?: string } }
  | { ok: false; error: string };

/** How one run starts; persisted fields land on its record. */
export interface RunStart {
  trigger: AgentTrigger;
  late?: boolean;
  /** The person's words. */
  input?: string;
  /** An event wake's script note; the run reads it before the person's words. */
  note?: string;
  /** Validated `_inbox/` files the person sent with their message. */
  attachments?: AttachmentRef[];
  /** The person's choice for their message; absent = `auto`. */
  continuation?: Exclude<AgentContinuation, "auto">;
  /** Where the person's message goes, fixed when it waited for the run in
   *  progress. Absent = the run decides when it starts. */
  thread?: ThreadTarget;
  events?: AgentEvent[];
  chainDepth?: number;
}

export type AgentColor = "neutral" | "blue" | "green" | "amber" | "purple" | "red";

/** Daily limits over the last 24 hours, checked before a scheduled run starts,
 *  never in the middle of one. */
export interface AgentBudget {
  runsPerDay?: number;
  tokensPerDay?: number;
  /** In the currency the harness reports (USD), only where it reports cost. */
  costPerDay?: number;
}

/** A tripped agent does not wake on its schedule until the cause clears
 *  (budget) or the user resumes it (failures). */
export interface AgentTrip {
  reason: "budget" | "failures";
  message: string;
  at: number;
}

export interface ScheduleTask {
  id: string;
  projectId: string;
  /** Owning Space; decides which Space's storage persists the task. Absent
   *  only on legacy tasks whose project could not be resolved yet. */
  spaceId?: string;
  /** The person who created the agent — in the Agents page, or through the
   *  `polyth_agents` tool of a chat that acts for them. Its runs act for them,
   *  and stop once they leave the Space. Absent on agents created before
   *  authorship or by a loop file: those runs act for nobody. Never edited. */
  ownerUserId?: string;
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
  /** Absent = "once". */
  catchUp?: CatchUpPolicy;
  enabled: boolean;
  /** Harness/model to execute with. Absent = inherit the target session or
   *  the auto-resolved default. */
  model?: ScheduleExecutionModel;
  harness?: HarnessSelection;
  /** Harness-qualified backups, highest priority first. A run moves to the
   *  next one only when the route itself fails (refused, unavailable, out of
   *  quota), never after a confirmed answer. */
  fallbackModels?: ScheduleExecutionModel[];
  /** Approval level of the agent's sessions; set by the owner in the app,
   *  never by a repository file. */
  permissions?: AgentPermissionLevel;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastError?: string;
  lastSessionId?: string;
  nextRunAt: number | null;
  runs: number;
  history?: ScheduleRunRecord[];
  /** Managed-loop provenance. UI-created tasks are "ui". */
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
  // ---- agent ----------------------------------------------------------------
  // A task is an agent: `title` is its name and `prompt` its charter (standing
  // instructions). `target.mode` is its context policy: new-session-per-run =
  // fresh, dedicated-session = rolling, existing-session = one chosen session.
  /** One sentence on what the agent is for. */
  description?: string;
  /** Glyph id from the agent icon set, shown on a tile in `color`. */
  icon?: string;
  color?: AgentColor;
  /** Wakes only when started by hand; the cadence is kept but never fires. */
  manualOnly?: boolean;
  /** Rolling context: start a new session once occupancy reaches this
   *  fraction (default 0.6). */
  rotateAt?: number;
  budget?: AgentBudget;
  /** Trip after this many failed runs in a row. Absent = never. */
  pauseAfterFailures?: number;
  tripped?: AgentTrip;
  /** `rollingKeyOf` of the charter/route the current rolling session was
   *  started with. */
  rollingKey?: string;
  /** Wakes on Polyth events (sessions finishing, other agents' runs). */
  eventTriggers?: AgentEventTrigger[];
  /** Per trigger id: events waiting out the quiet period, recent wakes. */
  paceState?: Record<string, PaceState>;
  /** Newest first, bounded: what event wakes did and why. */
  eventLog?: AgentEventLogEntry[];
  /** Absent = wait for a person (the session notifies as usual). */
  approvals?: AgentApprovalPolicy;
  /** Rolling context at `rotateAt`: start a new session (default) or ask the
   *  harness to compact the current one and repeat the charter. */
  whenFull?: "new-session" | "compact";
  /** Keep the rolling session's prompt cache warm between scheduled wakes. */
  keepWarm?: "off" | "auto";
  /** Keep-alives sent, newest last (last 24 h). */
  warmPings?: number[];
  /** Light, frequent checks inside the rolling conversation. */
  heartbeat?: AgentHeartbeat;
  nextBeatAt?: number | null;
  lastBeatAt?: number;
  /** Durable notes the agent keeps and the person may edit; every new
   *  session starts with them. */
  notebook?: string;
  /** Bumped on every notebook change. */
  notebookRev?: number;
  /** Revision the current rolling session has seen. */
  notebookSentRev?: number;
  notebookUpdatedAt?: number;
  notebookEditedBy?: "user" | "agent";
  /** The person last read the diary at this time. */
  seenAt?: number;
  /** Which finished runs notify the person. Absent = alerts only. */
  notify?: AgentNotifyPolicy;
  /** The person's messages waiting for the run in progress, oldest first.
   *  They start one run together: `queuedStart`. */
  queued?: AgentQueuedMessage[];
  /** The run the waiting messages start once the run in progress ends.
   *  Saved, so a restart sends it later; never dispatched while it is here,
   *  since the save that records its run removes it. */
  queuedStart?: RunStart;
}

export interface ScheduleTaskInput {
  projectId: string;
  /** Owning Space of `projectId`; resolved through `spaceOf` when omitted. */
  spaceId?: string;
  /** Set by the server from the signed-in person on create; never taken
   *  from request input and ignored on update. */
  ownerUserId?: string;
  prompt: string;
  kind?: ScheduleKind;
  at?: number;
  everyMinutes?: number;
  cadence?: ScheduleCadence;
  target?: ScheduleTarget;
  overlapPolicy?: OverlapPolicy;
  catchUp?: CatchUpPolicy;
  sessionId?: string;
  title?: string;
  enabled?: boolean;
  /** Explicit execution route; `null` clears a previously chosen route. */
  model?: ScheduleExecutionModel | null;
  harness?: HarnessSelection | null;
  /** Replaces the backups; `[]` or `null` removes them. Validated. */
  fallbackModels?: unknown[] | null;
  /** `null` restores the inherited approval level. */
  permissions?: AgentPermissionLevel | null;
  description?: string;
  icon?: string;
  color?: AgentColor;
  manualOnly?: boolean;
  rotateAt?: number;
  /** `null` clears every limit. */
  budget?: AgentBudget | null;
  /** `null` turns tripping on failures off. */
  pauseAfterFailures?: number | null;
  /** Replaces every event trigger; `[]` removes them. Validated. */
  eventTriggers?: unknown[];
  /** `null` restores waiting for a person. */
  approvals?: AgentApprovalPolicy | null;
  whenFull?: "new-session" | "compact";
  keepWarm?: "off" | "auto";
  /** `null` turns the heartbeat off. Validated. */
  heartbeat?: unknown | null;
  /** Replaces the notebook (the person edited it). */
  notebook?: string;
  notify?: AgentNotifyPolicy;
}

/** A run acts for the agent's owner; the session facade refuses the run if
 *  that person is no longer a member of the Space. */
export function scheduleTurnAdmission(task: Pick<ScheduleTask, "ownerUserId">): TurnAdmission | undefined {
  return task.ownerUserId ? { author: { userId: task.ownerUserId, via: "schedule" } } : undefined;
}

/** Resolve the send/create fields for one run. An explicit auto selection is
 *  never replayed: it would force an unattended harness re-resolution. When a
 *  model carries its own harness identity, that identity becomes the route. */
export function scheduleExecutionSelection(
  task: Pick<ScheduleTask, "model" | "harness">,
): ScheduleExecutionSelection {
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

/** Every route a run may use, main first, then each backup in priority
 *  order. A backup is always pinned to its own harness. A profile decides
 *  the route itself, so a profiled agent has no backups. */
export function scheduleExecutionRoutes(
  task: Pick<ScheduleTask, "model" | "harness" | "fallbackModels" | "agentProfile">,
): ScheduleExecutionSelection[] {
  const main = scheduleExecutionSelection(task);
  if (task.agentProfile) return [main];
  return [
    main,
    ...(task.fallbackModels ?? []).map((model) => scheduleExecutionSelection({ model })),
  ];
}

/** Rejections that mean the route itself cannot serve (refused model, sign-in,
 *  unavailable runtime, provider limits). Anything else — and every error
 *  without a code — may be uncertain, so it is never retried on a backup. */
export const ROUTE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "unsupported", "capability-unsupported", "invalid-model", "invalid-variant", "model-unavailable",
  "discovery-unavailable", "auth", "auth-expired", "runtime-unavailable", "unavailable",
  "native-failure", "runtime-rejected", "rate-limited", "quota-exhausted", "overloaded",
  "profile-harness-mismatch",
]);

export const isRouteFailure = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ROUTE_FAILURE_CODES.has(code);
};

/** Validate a backup list: harness-qualified refs, no duplicates, bounded. */
export function validateFallbackModels(raw: unknown): ScheduleExecutionModel[] {
  if (!Array.isArray(raw)) throw err("fallbackModels must be a list");
  if (raw.length > MAX_FALLBACK_MODELS) throw err(`at most ${MAX_FALLBACK_MODELS} backup models`);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const ref = item as Partial<ScheduleExecutionModel> | null;
    const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
    const providerID = text(ref?.providerID, 200);
    const modelID = text(ref?.modelID, 300);
    const harnessId = text(ref?.harnessId, 120);
    if (!providerID || !modelID) throw err(`backup model ${index + 1} needs a provider and a model`);
    if (!harnessId) throw err(`backup model ${index + 1} needs a harness`);
    const variant = ref?.variant === undefined ? undefined : text(ref.variant, 120);
    if (ref?.variant !== undefined && !variant) throw err(`backup model ${index + 1} has an invalid variant`);
    const key = `${harnessId}\u0000${providerID}\u0000${modelID}\u0000${variant ?? ""}`;
    if (seen.has(key)) throw err(`backup model ${index + 1} is listed twice`);
    seen.add(key);
    return { providerID, modelID, ...(variant ? { variant } : {}), harnessId };
  });
}

/** Files one message to an agent may carry (the session's own limit). */
export const MAX_RUN_ATTACHMENTS = 16;
const ATTACHMENT_MIME = /^[\w.+-]+\/[\w.+-]+$/;

export const AGENT_CONTINUATIONS: readonly AgentContinuation[] = ["auto", "continue", "new"];
export const isAgentContinuation = (value: unknown): value is AgentContinuation =>
  AGENT_CONTINUATIONS.includes(value as AgentContinuation);

/** Files the person sent with a message, rebuilt from untrusted input: only
 *  uploads in the project's `_inbox/` (file or image), with the same path
 *  rule the session's own message route enforces. The session validates and
 *  materializes them again when the run sends. Throws `invalid-input`. */
export function validateRunAttachments(raw: unknown): AttachmentRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw err("attachments must be a list");
  if (raw.length > MAX_RUN_ATTACHMENTS) throw err(`at most ${MAX_RUN_ATTACHMENTS} attachments`);
  return raw.map((item, index) => {
    const a = item as Record<string, unknown> | null;
    if (!a || typeof a !== "object" || Array.isArray(a)) throw err(`attachment ${index + 1} must be an object`);
    const id = typeof a.id === "string" && a.id.trim() && a.id.length <= 100 ? a.id : undefined;
    if (!id) throw err(`attachment ${index + 1} needs an id`);
    const name = typeof a.name === "string" ? a.name.trim() : "";
    if (!name || name.length > 200) throw err(`attachment ${index + 1} needs a name`);
    const mime = typeof a.mime === "string" && a.mime.length <= 100 && ATTACHMENT_MIME.test(a.mime) ? a.mime : undefined;
    if (!mime) throw err(`attachment mime invalid: ${name}`);
    const size = Number(a.size);
    if (!Number.isSafeInteger(size) || size < 0) throw err(`attachment size invalid: ${name}`);
    const kind = a.kind === undefined ? "file" : a.kind;
    if (kind !== "file" && kind !== "image") throw err(`attachment kind must be file or image: ${name}`);
    const path = a.path;
    if (typeof path !== "string" || path.length > 1024 || !path.startsWith("_inbox/") || path.length === "_inbox/".length
      || path.includes("\0") || path.includes("\\")
      || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw err(`attachment path must be an upload in _inbox/: ${name}`);
    }
    return { id, name, mime, size, kind, path };
  });
}

/** What a run record keeps of the files it was sent. */
const attachmentSummary = (refs: readonly AttachmentRef[]): AgentRunAttachment[] =>
  refs.map((ref) => ({
    name: ref.name,
    mime: ref.mime,
    size: ref.size,
    ...(ref.kind === "file" || ref.kind === "image" ? { kind: ref.kind } : {}),
    ...(ref.path ? { path: ref.path } : {}),
  }));

/** The start waiting behind a task's run in progress. */
interface WaitingStart {
  start: RunStart;
  /** Usually the task; a repository loop's one-off version otherwise. */
  executable: ScheduleTask;
  /** The person's messages in it, oldest first (see `ScheduleTask.queued`). */
  messages: AgentQueuedMessage[];
}

const FRESH_REASONS: readonly AgentFreshReason[] = ["asked", "idle", "instructions-changed", "context-full", "compacted", "unavailable", "none"];

/** Saved waiting messages as the page lists them; malformed ones are dropped. */
function restoreQueued(raw: unknown): AgentQueuedMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): AgentQueuedMessage[] => {
    const saved = item as Record<string, unknown> | null;
    if (!saved || typeof saved !== "object" || typeof saved.text !== "string"
      || typeof saved.at !== "number" || !Number.isFinite(saved.at)) return [];
    const files = saved.attachments;
    return [{
      text: saved.text.slice(0, AGENT_INPUT_LIMIT),
      at: saved.at,
      ...(typeof files === "number" && Number.isSafeInteger(files) && files > 0 ? { attachments: files } : {}),
      ...(saved.continuation === "continue" || saved.continuation === "new" ? { continuation: saved.continuation } : {}),
      ...(typeof saved.sessionId === "string" && saved.sessionId ? { sessionId: saved.sessionId } : {}),
    }];
  });
}

/** A saved `queuedStart`, checked again on load. Only the person's start
 *  (their words or files) is ever saved; anything else is undefined. */
function restoreQueuedStart(raw: unknown): RunStart | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const saved = raw as Record<string, unknown>;
  if (saved.trigger !== "manual" && saved.trigger !== "event") return undefined;
  let attachments: AttachmentRef[];
  try { attachments = validateRunAttachments(saved.attachments); } catch { return undefined; }
  const input = typeof saved.input === "string" ? saved.input.slice(0, AGENT_INPUT_LIMIT) : "";
  if (!input && !attachments.length) return undefined;
  const events = saved.events;
  if (events !== undefined
    && (!Array.isArray(events) || events.some((event) => !event || typeof event !== "object" || Array.isArray(event)))) {
    return undefined;
  }
  const savedThread = saved.thread && typeof saved.thread === "object" ? saved.thread as Record<string, unknown> : undefined;
  const thread: ThreadTarget | undefined = !savedThread ? undefined
    : typeof savedThread.sessionId === "string" && savedThread.sessionId
      ? {
        sessionId: savedThread.sessionId,
        ...(typeof savedThread.key === "string" ? { key: savedThread.key } : {}),
        ...(typeof savedThread.at === "number" && Number.isFinite(savedThread.at) ? { at: savedThread.at } : {}),
      }
      : FRESH_REASONS.includes(savedThread.reason as AgentFreshReason) ? { reason: savedThread.reason as AgentFreshReason } : undefined;
  const chainDepth = saved.chainDepth;
  return {
    trigger: saved.trigger,
    ...(saved.late === true ? { late: true } : {}),
    ...(input ? { input } : {}),
    ...(typeof saved.note === "string" && saved.note ? { note: saved.note } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(saved.continuation === "continue" || saved.continuation === "new" ? { continuation: saved.continuation } : {}),
    ...(thread ? { thread } : {}),
    ...(Array.isArray(events) && events.length ? { events: events as AgentEvent[] } : {}),
    ...(typeof chainDepth === "number" && Number.isSafeInteger(chainDepth) && chainDepth > 0 ? { chainDepth } : {}),
  };
}

/** What `run` learned at admission; persisted on the run record so the
 *  outcome can still be settled after a restart. */
export interface ScheduleRunOutcome {
  sessionId?: string;
  markerSeq?: number;
  queueId?: string;
  turnId?: string;
  /** Set when a rolling agent started a new session for this run. */
  rollingKey?: string;
  rotated?: ScheduleRunRecord["rotated"];
  /** Notebook revision the run's prompt carried, when it carried one. */
  notebookRev?: number;
  /** 1-based backup that admitted the run; absent = the main route. */
  backup?: number;
  /** See the run record's fields of the same names. */
  key?: string;
  continued?: boolean;
  fresh?: AgentFreshReason;
}

export interface ScheduleRunSettlement {
  status: "ok" | "failed" | "unknown";
  error?: string;
  summary?: string;
  tokens?: TokenUsage;
  cost?: number;
  /** 1-based backup the run moved to while it ran. */
  backup?: number;
}

export interface ScheduleRunner {
  /** Admit the run (create/choose the session and submit the prompt).
   *  Resolves once the prompt is accepted, not when the agent finishes. */
  run(task: ScheduleTask, runId: string, wake: AgentWake): Promise<ScheduleRunOutcome | void>;
  /** Resolve when the admitted turn has actually stopped. Rejecting after
   *  `signal` aborts leaves the run `running` for the next start() to resume.
   *  Without `settle`, admission is the outcome. */
  settle?(
    task: ScheduleTask,
    run: ScheduleRunRecord,
    signal: AbortSignal,
    /** Approval requests that currently wait in the run's session. */
    onWaiting?: (waiting: AgentWaitingRequest[]) => void,
    /** The run's newest step, and how many tool steps it took so far. */
    onActivity?: (activity: AgentRunActivity, steps: number) => void,
  ): Promise<ScheduleRunSettlement>;
  /** Where a message from the person would go at `at` (the decision the
   *  owner's `followUp` preview shows). Fixes a waiting message's
   *  conversation when it queues; without it the run decides when it starts. */
  thread?(task: ScheduleTask, continuation: AgentContinuation, at: number): Promise<ThreadTarget | undefined>;
}

export interface ScheduleServiceOptions {
  /** JSON file path, e.g. `${dataDir}/schedule.json`. With `spaceFile` this
   *  is the legacy shared file: it only keeps tasks whose Space is unknown. */
  file: string;
  /** Per-Space document path. Every task with a `spaceId` persists there. */
  spaceFile?: (spaceId: string) => string;
  /** Spaces whose documents are read at construction. */
  spaceIds?: string[];
  /** Synchronous project → Space lookup for tasks created without one. */
  spaceOf?: (projectId: string) => string | undefined;
  runner: ScheduleRunner;
  now?: () => number;
  /** Timer resolution for start(); due checks also run via tick(). */
  tickMs?: number;
  /** Fastest allowed cron cadence. */
  minCronIntervalMinutes?: number;
  /** A due time older than this when the tick sees it counts as missed. */
  missedGraceMs?: number;
  /** How long a person's message holds the agent's message lock while its
   *  run is admitted; later messages queue after it (default 30 s). */
  admissionWaitMs?: number;
  /** How long start() waits for the observers a stop released before it
   *  reconciles; one that lets go later is followed again once it has
   *  (default 10 s). */
  releaseWaitMs?: number;
  /** Scheduled runs in flight across every agent; a due agent beyond this
   *  records a skip instead of piling more sessions onto the host. */
  maxConcurrentRuns?: number;
  /** Runs a wake script in a sandbox. Without it, a wake with a script never fires. */
  runScript?: (task: ScheduleTask, script: string, events: AgentEvent[]) => Promise<WakeScriptResult>;
  /** A finished run deserves the person's attention: its report met the
   *  agent's notify policy, or a failure streak stopped the agent. */
  notify?: (task: ScheduleTask, run: ScheduleRunRecord, reason: "report" | "tripped") => void;
}

export interface SchedulePreview {
  runs: number[];
  description: string;
}

/** Persisted.agents/loops scan diagnostic: survives
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
  /** Fire a task immediately, ignoring its clock and daily limits (the user
   *  asked for it). `input` reaches the agent as text from the user and
   *  `attachments` (validated, see `validateRunAttachments`) as their files;
   *  either makes it the person's message, which waits for a run in progress
   *  instead of being dropped (saved, so a restart sends it later).
   *  `continuation` is their choice of conversation. While the service is
   *  stopped the message is saved and sent after start(). Refuses: `new` for
   *  an agent bound to a chosen session (invalid-input), a message that would
   *  join a loop's waiting one-off version (conflict), one the waiting run
   *  could not carry whole (payload-too-large), and a wake without the
   *  person's words while stopped (unavailable). */
  runNow(id: string, opts?: { input?: string; attachments?: unknown[]; continuation?: AgentContinuation }): Promise<ScheduleTask>;
  /** Offer a Polyth event to every agent whose event wake matches it. */
  dispatchEvent(event: AgentEvent): void;
  /** Agent (and chain depth) whose run owns `sessionId`, if any. `trigger`
   *  is what woke the newest run in that session. `scheduledMessage`: the
   *  session is a person's chat the task only posts into. */
  agentForSession(sessionId: string): {
    agentId: string;
    name: string;
    chainDepth: number;
    trigger?: AgentTrigger;
    scheduledMessage?: boolean;
  } | undefined;
  /** Wake event-paced agents whose quiet period ended. Timer + tests use this. */
  flushEvents(): Promise<number>;
  /** An anonymous webhook call; the token is the only authority. */
  receiveWebhook(token: string, input: { title?: string; event?: string; text: string }): "accepted" | "unknown" | "throttled";
  /** Webhook URL tokens minted by the last create/update of `id`; read once. */
  takeIssuedWebhookTokens(id: string): Record<string, string>;
  /** Projects with an active agent waking on integration `source`. */
  subscribed(source: string): Array<{ spaceId: string; projectId: string }>;
  /** Turn `id` into a repository-defined agent backed by `file`, which the
   *  person just wrote from it (trusted as exactly these bytes). */
  adoptFile(id: string, spaceId: string, file: LoopFileResult): ScheduleTask;
  /** Forget the rolling session: the next run starts a new one. */
  resetSession(id: string): ScheduleTask;
  /** Record a keep-alive sent to the rolling session. */
  recordWarm(id: string, at: number): void;
  /** Whether a run of `id` is admitted or in progress in this process. */
  isRunning(id: string): boolean;
  /** The person read the diary up to `at` (never moves back). */
  markSeen(id: string, at?: number): ScheduleTask;
  /** Record (or with `null` clear) the person's verdict on one run's report. */
  setFeedback(id: string, runId: string, feedback: { verdict: "up" | "down"; note?: string } | null): ScheduleTask;
  /** The person stops the runs in progress: marks them and returns their
   *  sessions, which the caller aborts. */
  requestStop(id: string): string[];
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
  /** Attach Space ownership to tasks created before their project resolved;
   *  returns how many moved into a Space document. */
  assignSpaces(): number;
  /** Arms the timer, resumes settlement of runs left `running` and sends
   *  the person's saved waiting messages once those runs end. After a
   *  stop(), it does so once the observers that stop released let go. */
  start(): void;
  /** Disarms the timer and detaches settlement observers (runs stay
   *  `running`). Until start(), nothing starts: the person's messages are
   *  saved, clock and event wakes wait, other wakes are refused. */
  stop(): void;
}

const HISTORY_LIMIT = 50;
/** Journal note bound; the full answer stays in the session. */
const SUMMARY_LIMIT = 2_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const INPUT_LIMIT = AGENT_INPUT_LIMIT;
const WEBHOOK_PER_MINUTE = 120;
const WEBHOOK_TEXT_LIMIT = 4_000;
const DEFAULT_MISSED_GRACE_MS = 5 * 60_000;
const DEFAULT_ADMISSION_WAIT_MS = 30_000;
/** How long start() waits for the observers a stop() released; a run whose
 *  observer still holds on is skipped, as it was before this wait. */
const RELEASE_WAIT_MS = 10_000;
const FEEDBACK_NOTE_LIMIT = 500;

const targetModeOf = (t: Pick<ScheduleTask, "target" | "sessionId">): NonNullable<ScheduleTarget["mode"]> =>
  t.target?.mode ?? (t.sessionId ? "existing-session" : "new-session-per-run");

/** Whether a finished run reaches the person as a notification. Failures
 *  speak through the failure streak instead (see `pauseAfterFailures`). */
export function reportNotifies(
  policy: AgentNotifyPolicy | undefined,
  run: Pick<ScheduleRunRecord, "status" | "signal">,
): boolean {
  const effective = policy ?? "alerts";
  if (effective === "off" || run.status !== "ok") return false;
  return run.signal === "alert" || (effective === "updates" && run.signal === "update");
}

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

const AGENT_COLORS: readonly AgentColor[] = ["neutral", "blue", "green", "amber", "purple", "red"];

const limitOf = (value: unknown, name: string, integer: boolean): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw err(`${name} must be a positive ${integer ? "whole number" : "number"}`);
  }
  return value;
};

/** Validate and apply the agent fields present on `input` (absent = keep).
 *  Returns webhook URL tokens minted for new webhook wakes, by trigger id;
 *  only their SHA-256 is stored, so this is the one time they exist. */
function applyAgentFields(t: ScheduleTask, input: Partial<ScheduleTaskInput>): Record<string, string> {
  const issued: Record<string, string> = {};
  if (input.description !== undefined) {
    const description = input.description.trim().slice(0, 280);
    if (description) t.description = description;
    else delete t.description;
  }
  if (input.icon !== undefined) {
    const icon = input.icon.trim();
    if (icon && !/^[a-z0-9-]{1,32}$/.test(icon)) throw err("icon must be a short glyph id");
    if (icon) t.icon = icon;
    else delete t.icon;
  }
  if (input.color !== undefined) {
    if (!AGENT_COLORS.includes(input.color)) throw err(`color must be one of ${AGENT_COLORS.join(", ")}`);
    t.color = input.color;
  }
  if (input.manualOnly !== undefined) {
    if (input.manualOnly) t.manualOnly = true;
    else delete t.manualOnly;
  }
  if (input.rotateAt !== undefined) {
    if (typeof input.rotateAt !== "number" || !(input.rotateAt >= 0.2 && input.rotateAt <= 0.9)) {
      throw err("rotateAt must be between 0.2 and 0.9");
    }
    t.rotateAt = input.rotateAt;
  }
  if (input.budget !== undefined) {
    const budget: AgentBudget = {};
    const runs = limitOf(input.budget?.runsPerDay, "runsPerDay", true);
    const tokens = limitOf(input.budget?.tokensPerDay, "tokensPerDay", true);
    const cost = limitOf(input.budget?.costPerDay, "costPerDay", false);
    if (runs !== undefined) budget.runsPerDay = runs;
    if (tokens !== undefined) budget.tokensPerDay = tokens;
    if (cost !== undefined) budget.costPerDay = cost;
    if (Object.keys(budget).length) t.budget = budget;
    else delete t.budget;
    // New limits may lift (or not yet justify) a budget trip; the next tick decides.
  }
  if (input.eventTriggers !== undefined) {
    if (!Array.isArray(input.eventTriggers)) throw err("eventTriggers must be a list");
    if (input.eventTriggers.length > MAX_EVENT_TRIGGERS) throw err(`at most ${MAX_EVENT_TRIGGERS} event wakes`);
    const previous = new Map((t.eventTriggers ?? []).map((trigger) => [trigger.id, trigger]));
    const triggers = input.eventTriggers.map(validateTrigger).map((trigger) => {
      if (trigger.kind !== "webhook") return trigger;
      const kept = previous.get(trigger.id);
      if (kept?.kind === "webhook" && kept.tokenHash) return { ...trigger, tokenHash: kept.tokenHash };
      const token = randomBytes(32).toString("base64url");
      issued[trigger.id] = token;
      return { ...trigger, tokenHash: webhookTokenHash(token) };
    });
    if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) throw err("event wake ids must be unique");
    if (triggers.some((trigger) => trigger.kind === "agent" && trigger.agentId === t.id)) throw err("an agent cannot wake on its own runs");
    if (triggers.length) t.eventTriggers = triggers;
    else delete t.eventTriggers;
    // Pending events of removed triggers go with them.
    const kept = new Set(triggers.map((trigger) => trigger.id));
    for (const id of Object.keys(t.paceState ?? {})) if (!kept.has(id)) delete t.paceState![id];
  }
  if (input.whenFull !== undefined) {
    if (input.whenFull !== "new-session" && input.whenFull !== "compact") throw err("whenFull must be new-session or compact");
    if (input.whenFull === "compact") t.whenFull = "compact";
    else delete t.whenFull;
  }
  if (input.keepWarm !== undefined) {
    if (input.keepWarm !== "off" && input.keepWarm !== "auto") throw err("keepWarm must be off or auto");
    if (input.keepWarm === "auto") t.keepWarm = "auto";
    else delete t.keepWarm;
  }
  if (input.approvals !== undefined) {
    if (input.approvals === null) delete t.approvals;
    else {
      const minutes = Number(input.approvals.timeoutMinutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw err("timeoutMinutes must be 1 to 1440");
      if (!["wait", "reject", "stop"].includes(input.approvals.onTimeout)) throw err("onTimeout must be wait, reject or stop");
      t.approvals = { timeoutMinutes: minutes, onTimeout: input.approvals.onTimeout };
    }
  }
  if (input.pauseAfterFailures !== undefined) {
    const limit = limitOf(input.pauseAfterFailures, "pauseAfterFailures", true);
    if (limit !== undefined) t.pauseAfterFailures = limit;
    else delete t.pauseAfterFailures;
  }
  if (input.heartbeat !== undefined) {
    if (input.heartbeat === null) delete t.heartbeat;
    else t.heartbeat = validateHeartbeat(input.heartbeat);
  }
  if (input.notify !== undefined) {
    if (!["alerts", "updates", "off"].includes(input.notify)) throw err("notify must be alerts, updates or off");
    if (input.notify === "alerts") delete t.notify;
    else t.notify = input.notify;
  }
  if (input.fallbackModels !== undefined) {
    const backups = input.fallbackModels === null ? [] : validateFallbackModels(input.fallbackModels);
    if (backups.length) t.fallbackModels = backups;
    else delete t.fallbackModels;
  }
  if (input.permissions !== undefined) {
    if (input.permissions === null) delete t.permissions;
    else if (!AGENT_PERMISSION_LEVELS.includes(input.permissions)) throw err("permissions must be ask, routine or all");
    else t.permissions = input.permissions;
  }
  return issued;
}

/** A heartbeat continues the agent's one ongoing conversation; a fresh
 *  session per beat would lose what it already checked. */
function assertHeartbeatContext(t: Pick<ScheduleTask, "heartbeat" | "target" | "sessionId">): void {
  if (t.heartbeat && targetModeOf(t) !== "dedicated-session") {
    throw err("a heartbeat needs the agent's ongoing conversation: set its memory to rolling");
  }
}

/** Stored form of a webhook URL token. */
export const webhookTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Mirror cadence back onto the legacy fields the existing UI/API read. */
function mirrorCadence(t: ScheduleTask): void {
  t.kind = t.cadence.kind;
  if (t.cadence.kind === "at") t.at = t.cadence.at;
  if (t.cadence.kind === "every") t.everyMinutes = t.cadence.everyMinutes;
}

/** Everything a file decides about execution. Legacy loops keep their
 *  original shape so existing trust receipts stay valid; agent files add
 *  every setting, so any change to them needs a new approval. */
const loopExecutableShape = (loop: NonNullable<LoopFileResult["loop"]>) => ({
  title: loop.title,
  cadence: { kind: "cron" as const, expression: loop.cron, timeZone: loop.timeZone },
  enabled: loop.enabled,
  agentProfile: loop.agentProfile ?? null,
  prompt: loop.prompt,
  ...(loop.file ? { file: loop.file } : {}),
});

/** Content-trust kind of a repository definition, by its directory. */
const sourceKindOf = (path: string): string =>
  path.replace(/\\/g, "/").includes("/.agents/agents/") ? "agents-agent" : "agents-loop";

/** Parse `provider/model#variant` from an agent file. */
function modelFromFile(model: string | undefined, harness: string | undefined): ScheduleExecutionModel | undefined {
  if (!model) return undefined;
  const [ref, variant] = model.split("#");
  const slash = ref!.indexOf("/");
  return {
    providerID: ref!.slice(0, slash),
    modelID: ref!.slice(slash + 1),
    ...(variant ? { variant } : {}),
    ...(harness ? { harnessId: harness } : {}),
  };
}

/** Make `t` exactly what an agent file says; absent settings fall back to defaults. */
function applyFileSpec(t: ScheduleTask, spec: AgentFileSpec): void {
  t.title = spec.name;
  t.prompt = spec.charter;
  if (spec.schedule) {
    t.cadence = { kind: "cron", expression: spec.schedule.cron, timeZone: spec.schedule.timeZone };
    delete t.manualOnly;
  } else {
    t.cadence ??= { kind: "every", everyMinutes: 60 };
    t.manualOnly = true;
  }
  const set = <K extends keyof ScheduleTask>(key: K, value: ScheduleTask[K] | undefined) => {
    if (value === undefined) delete t[key];
    else t[key] = value;
  };
  set("description", spec.description);
  set("icon", spec.icon);
  set("color", spec.color);
  t.target = { mode: spec.context === "rolling" ? "dedicated-session" : "new-session-per-run" };
  delete t.sessionId;
  set("rotateAt", spec.rotateAt);
  set("whenFull", spec.whenFull === "compact" ? "compact" : undefined);
  set("keepWarm", spec.keepWarm === "auto" ? "auto" : undefined);
  set("overlapPolicy", spec.overlap);
  set("catchUp", spec.catchUp);
  set("agentProfile", spec.agentProfile);
  set("model", modelFromFile(spec.model, spec.harness));
  set("harness", spec.harness ? { mode: "pinned", harnessId: spec.harness } : undefined);
  applyAgentFields(t, {
    budget: spec.budget ?? null,
    pauseAfterFailures: spec.pauseAfterFailures ?? null,
    approvals: spec.approvals ?? null,
    eventTriggers: spec.wakes ?? [],
    heartbeat: spec.heartbeat ?? null,
    notify: spec.notify ?? "alerts",
    fallbackModels: fallbacksFromFile(spec.fallbackModels),
  });
  // A repository file never decides how much its agent may do unasked.
  delete t.permissions;
}

/** An agent as an agent/v1 file. Throws when a setting cannot live in a
 *  repository file (a one-off time, a chosen local session, a webhook). */
export function agentSpecOf(t: ScheduleTask, id: string): AgentFileSpec {
  const mode = t.target?.mode ?? (t.sessionId ? "existing-session" : "new-session-per-run");
  if (mode === "existing-session") throw err("an agent that runs in one chosen session cannot be stored in a file", "unsupported");
  if (!t.manualOnly && t.cadence.kind !== "cron") throw err("only weekly or monthly schedules can be stored in a file", "unsupported");
  if (t.eventTriggers?.some((trigger) => trigger.kind === "webhook")) {
    throw err("webhook wakes have a secret URL and cannot be stored in a file; remove them first", "unsupported");
  }
  const model = t.model ? `${t.model.providerID}/${t.model.modelID}${t.model.variant ? `#${t.model.variant}` : ""}` : undefined;
  const harness = t.harness?.mode === "pinned" ? t.harness.harnessId : t.model?.harnessId;
  return {
    id,
    name: t.title?.trim() || id,
    ...(t.description ? { description: t.description } : {}),
    ...(t.icon ? { icon: t.icon } : {}),
    ...(t.color ? { color: t.color } : {}),
    ...(!t.manualOnly && t.cadence.kind === "cron" ? { schedule: { cron: t.cadence.expression, timeZone: t.cadence.timeZone } } : {}),
    enabled: t.enabled,
    context: mode === "dedicated-session" ? "rolling" : "fresh",
    ...(t.rotateAt !== undefined ? { rotateAt: t.rotateAt } : {}),
    ...(t.whenFull === "compact" ? { whenFull: "compact" as const } : {}),
    ...(t.keepWarm === "auto" ? { keepWarm: "auto" as const } : {}),
    ...(t.overlapPolicy ? { overlap: t.overlapPolicy } : {}),
    ...(t.catchUp ? { catchUp: t.catchUp } : {}),
    ...(t.agentProfile ? { agentProfile: t.agentProfile } : {}),
    ...(model ? { model } : {}),
    ...(harness ? { harness } : {}),
    ...(t.fallbackModels?.length ? { fallbackModels: fallbacksToFile(t.fallbackModels) } : {}),
    ...(t.budget && Object.keys(t.budget).length ? { budget: t.budget } : {}),
    ...(t.pauseAfterFailures ? { pauseAfterFailures: t.pauseAfterFailures } : {}),
    ...(t.approvals ? { approvals: t.approvals } : {}),
    ...(t.eventTriggers?.length ? { wakes: t.eventTriggers } : {}),
    ...(t.heartbeat ? { heartbeat: t.heartbeat } : {}),
    ...(t.notify ? { notify: t.notify } : {}),
    charter: t.prompt,
  };
}

export function loopSemanticDigest(loop: NonNullable<LoopFileResult["loop"]>): string {
  return createHash("sha256").update(JSON.stringify(loopExecutableShape(loop))).digest("hex");
}

function applyLoopExecutable(task: ScheduleTask, loop: NonNullable<LoopFileResult["loop"]>): void {
  if (loop.file) {
    applyFileSpec(task, loop.file);
    mirrorCadence(task);
    return;
  }
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
  const scheduleDiffers = loop.cron
    ? task.cadence.kind !== "cron" || task.cadence.expression !== loop.cron || task.cadence.timeZone !== loop.timeZone
      || (loop.file !== undefined && task.manualOnly === true)
    : !task.manualOnly;
  if (scheduleDiffers) fields.push("schedule");
  if ((task.agentProfile ?? "") !== (loop.agentProfile ?? "")) fields.push("agentProfile");
  if (loop.file) {
    // Everything else the file decides, compared through one shape.
    const probe = structuredClone(task);
    try {
      applyFileSpec(probe, loop.file);
      // Name, body, schedule and profile are reported above; `enabled` is a local override.
      const strip = ({ name: _n, charter: _c, schedule: _s, agentProfile: _a, enabled: _e, ...rest }: AgentFileSpec) => rest;
      if (JSON.stringify(strip(agentSpecOf(probe, loop.id))) !== JSON.stringify(strip(agentSpecOf(task, loop.id)))) fields.push("settings");
    } catch {
      fields.push("settings");
    }
  }
  return fields;
}

function trustSubject(task: Pick<ScheduleTask, "projectId">, file: LoopFileResult, spaceId: string): ContentTrustSubject {
  if (!file.loop || !file.digest) throw err("loop version is not executable", "content-trust-changed");
  return {
    spaceId,
    projectId: task.projectId,
    sourceKind: sourceKindOf(file.path),
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
/** Identity of what a rolling session was started with. A different charter,
 *  model, harness or profile needs a new session: the old one carries stale
 *  instructions and a cache prefix that no longer matches. */
export function rollingKeyOf(task: Pick<ScheduleTask, "prompt" | "model" | "harness" | "agentProfile">): string {
  return createHash("sha256").update(JSON.stringify([
    task.prompt.trim(),
    task.model ?? null,
    task.harness?.mode === "pinned" ? task.harness.harnessId : null,
    task.agentProfile ?? null,
  ])).digest("hex").slice(0, 16);
}

export function computeNextRun(
  task: Pick<ScheduleTask, "cadence" | "enabled" | "lastRunAt" | "runs" | "manualOnly" | "tripped">,
  now: number,
): number | null {
  if (!task.enabled || task.manualOnly || task.tripped) return null;
  const c = task.cadence;
  if (c.kind === "at") return task.runs > 0 || !Number.isFinite(c.at) ? null : c.at;
  if (c.kind === "every") return (task.lastRunAt ?? now) + c.everyMinutes * 60_000;
  try {
    return nextRun(c.expression, c.timeZone, Math.max(task.lastRunAt ?? 0, now));
  } catch {
    return null; // invalid cron cannot fire; parseError surfaces the reason
  }
}

/** Re-arm both clocks after a change of settings or state. */
function rearm(t: ScheduleTask, at: number): void {
  t.nextRunAt = computeNextRun(t, at);
  if (t.heartbeat) t.nextBeatAt = computeNextBeat(t, at);
  else delete t.nextBeatAt;
}

/** Stop both clocks (paused, blocked or tripped). */
function disarm(t: ScheduleTask): void {
  t.nextRunAt = null;
  if (t.heartbeat) t.nextBeatAt = null;
}

/** The person's notebook text replaces the agent's copy. */
function writeNotebook(t: ScheduleTask, text: string, at: number): void {
  const next = text.replace(/\r\n/g, "\n").trim().slice(0, NOTEBOOK_LIMIT);
  if (next === (t.notebook ?? "")) return;
  if (next) t.notebook = next;
  else delete t.notebook;
  t.notebookRev = (t.notebookRev ?? 0) + 1;
  t.notebookUpdatedAt = at;
  t.notebookEditedBy = "user";
}

export function createScheduleService(opts: ScheduleServiceOptions): ScheduleService {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 15_000;
  const minCronMinutes = opts.minCronIntervalMinutes ?? 1;
  const missedGraceMs = opts.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
  const maxConcurrent = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  let timer: ReturnType<typeof setInterval> | null = null;
  const legacy = load(opts.file);
  let tasks: ScheduleTask[] = [];
  // projectId -> persisted scan diagnostics (survive refresh + restart)
  const loopErrorsByProject: Record<string, ScheduleLoopError[]> = {};
  // Spaces that own a document; each one is rewritten on save so removing a
  // Space's last task empties its file instead of leaving it stale.
  const knownSpaces = new Set<string>();
  // A document from before the current schema changed on load: save it once.
  let schemaMoved = legacy.migrated;
  {
    // A Space document wins over the legacy copy of the same task: a crash
    // between writing the Space file and rewriting the legacy file leaves both.
    const byId = new Map<string, ScheduleTask>();
    for (const spaceId of opts.spaceFile ? opts.spaceIds ?? [] : []) {
      const doc = load(opts.spaceFile!(spaceId));
      if (doc.migrated) schemaMoved = true;
      knownSpaces.add(spaceId);
      // The document's location, not a field inside it, decides ownership.
      for (const t of doc.tasks) byId.set(t.id, { ...t, spaceId });
      Object.assign(loopErrorsByProject, doc.loopErrors);
    }
    for (const t of legacy.tasks) if (!byId.has(t.id)) byId.set(t.id, t);
    for (const [projectId, errors] of Object.entries(legacy.loopErrors)) {
      loopErrorsByProject[projectId] ??= errors;
    }
    tasks = [...byId.values()];
  }
  // task id -> in-flight run (admission through settlement); overlap policy consults it
  const running = new Map<string, Promise<void>>();
  // task id -> the one successor waiting under the "queue" policy. The
  // person's later messages join it instead of being dropped; once it carries
  // their words it is saved in the task (`queuedStart`).
  const queuedNext = new Map<string, WaitingStart>();
  // task id -> the person's message being queued or started; one at a time
  // per agent, so each sees where the one before it went.
  const queueLocks = new Map<string, Promise<void>>();
  // Bumped by stop(): a wait set up before it never starts its run.
  let generation = 0;
  // `stopped` from stop() until start(); `starting` while start() waits for
  // the observers a stop released. Meanwhile nothing starts and the person's
  // messages are saved to wait. `idle`: never started (tests drive tick()).
  let phase: "idle" | "starting" | "running" | "stopped" = "idle";
  const paused = (): boolean => phase === "stopped" || phase === "starting";
  // run id -> the observe() in progress for it, with the signal it follows
  // (aborted: a stop released it and it is letting go of the run).
  const watching = new Map<string, { signal: AbortSignal; watched: Promise<void> }>();
  const admissionWaitMs = opts.admissionWaitMs ?? DEFAULT_ADMISSION_WAIT_MS;
  // run ids whose admission or settlement is in progress in this process
  const inFlight = new Set<string>();
  let observers = new AbortController();

  // One-time migration. Pre-content-trust managed tasks are never grandfathered
  // into execution merely because their old path/digest record exists.
  let migrated = schemaMoved;
  for (const t of tasks) {
    // A waiting start is kept only whole; stray messages without one (older
    // files) are dropped.
    const waiting = restoreQueuedStart(t.queuedStart);
    if (waiting) {
      t.queuedStart = waiting;
      t.queued = restoreQueued(t.queued);
    } else {
      delete t.queuedStart;
      delete t.queued;
    }
    if (!t.cadence) {
      t.cadence = t.kind === "at"
        ? { kind: "at", at: t.at ?? 0 }
        : { kind: "every", everyMinutes: t.everyMinutes ?? 1 };
      migrated = true;
    }
    if (t.source === "loop-file" && !t.trustReceipt) {
      t.trustState = "untrusted";
      t.enabled = false;
      disarm(t);
      migrated = true;
    }
  }

  const writeDoc = (file: string, doc: Record<string, unknown>): void => {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify({ v: SCHEMA_VERSION, ...doc }, null, 2));
  };

  // Live activity changes on every streamed chunk; the file follows it at
  // most about once a second (any other save writes it too).
  const ACTIVITY_SAVE_MS = 1_000;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSaveAt = 0;

  const save = (): void => {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = null;
    lastSaveAt = Date.now();
    if (!opts.spaceFile) {
      writeDoc(opts.file, { tasks, loopErrors: loopErrorsByProject });
      return;
    }
    const groups = new Map<string | undefined, { tasks: ScheduleTask[]; loopErrors: Record<string, ScheduleLoopError[]> }>();
    const group = (spaceId: string | undefined) => {
      let g = groups.get(spaceId);
      if (!g) groups.set(spaceId, g = { tasks: [], loopErrors: {} });
      return g;
    };
    for (const spaceId of knownSpaces) group(spaceId);
    for (const t of tasks) group(t.spaceId).tasks.push(t);
    for (const [projectId, errors] of Object.entries(loopErrorsByProject)) {
      const spaceId = tasks.find((t) => t.projectId === projectId && t.spaceId)?.spaceId
        ?? opts.spaceOf?.(projectId);
      group(spaceId).loopErrors[projectId] = errors;
    }
    // Space documents first: the legacy file only drops a task after its
    // Space copy is durable.
    for (const [spaceId, doc] of groups) {
      if (spaceId === undefined) continue;
      knownSpaces.add(spaceId);
      writeDoc(opts.spaceFile(spaceId), { spaceId, ...doc });
    }
    const rest = groups.get(undefined);
    if (rest?.tasks.length || Object.keys(rest?.loopErrors ?? {}).length || existsSync(opts.file)) {
      writeDoc(opts.file, rest ?? { tasks: [], loopErrors: {} });
    }
  };

  const saveActivitySoon = (): void => {
    if (activityTimer) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      try { save(); } catch (error) { console.error("[agents] saving run activity failed", error); }
    }, Math.max(0, lastSaveAt + ACTIVITY_SAVE_MS - Date.now()));
    activityTimer.unref?.();
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
    if (moved && opts.spaceFile && existsSync(opts.file)) {
      // Keep the pre-split shared document once, byte for byte.
      const backup = `${opts.file}.pre-space-split`;
      if (!existsSync(backup)) copyFileSync(opts.file, backup);
    }
    return moved;
  };
  if (assignSpaces() > 0) migrated = true;
  if (migrated) save();

  const mustGet = (id: string): ScheduleTask => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw err("task not found", "not-found");
    return t;
  };

  const pushHistory = (t: ScheduleTask, rec: ScheduleRunRecord): void => {
    t.history = [rec, ...(t.history ?? [])].slice(0, HISTORY_LIMIT);
  };

  /** Notes from a run's report go into the notebook. A rolling session that
   *  wrote them already knows them, so it is not sent the notebook again. */
  const remember = (task: ScheduleTask, rec: ScheduleRunRecord, notes: string[]): void => {
    if (!notes.length) return;
    const { notebook, added } = appendToNotebook(task.notebook, notes);
    if (!added.length) return;
    const before = task.notebookRev ?? 0;
    const seen = task.notebookSentRev === before && rec.sessionId !== undefined && rec.sessionId === task.lastSessionId;
    task.notebook = notebook;
    task.notebookRev = before + 1;
    task.notebookUpdatedAt = now();
    task.notebookEditedBy = "agent";
    if (seen) task.notebookSentRev = task.notebookRev;
    rec.remembered = added;
  };

  /** `task` owns canonical history/clock state; `executableTask` may be an
   * exact one-shot repository snapshot which must never replace canonical
   * approved prompt/cadence fields. */
  const finish = (task: ScheduleTask, rec: ScheduleRunRecord, result: ScheduleRunSettlement): void => {
    rec.status = result.status;
    rec.finishedAt = now();
    if (result.error) rec.error = result.error;
    else delete rec.error;
    if (result.summary !== undefined) {
      // The report line and notes are protocol, not prose: keep them apart.
      const report = parseAgentReport(result.summary);
      if (report.body) rec.summary = report.body.slice(0, SUMMARY_LIMIT);
      else delete rec.summary;
      const signal = report.signal ?? (result.status === "ok" ? "update" : undefined);
      if (signal) rec.signal = signal;
      const headline = report.headline ?? (signal && signal !== "quiet" ? headlineFrom(report.body) : undefined);
      if (headline) rec.headline = headline;
      if (result.status === "ok") remember(task, rec, report.remember);
    } else if (result.status === "ok") {
      rec.signal = "update";
    }
    if (result.tokens) rec.tokens = result.tokens;
    if (result.cost !== undefined) rec.cost = result.cost;
    if (result.backup) rec.backup = result.backup;
    // The newest step only means something while the run works; the count stays.
    delete rec.activity;
    if (result.status === "ok") delete task.lastError;
    else task.lastError = rec.error ?? "The run's result could not be confirmed.";
    let tripped = false;
    if (result.status === "failed" && !task.tripped && failureStreakReached(task.history, task.pauseAfterFailures)) {
      task.tripped = {
        reason: "failures",
        message: `Stopped after ${task.pauseAfterFailures} failed runs in a row.`,
        at: now(),
      };
      disarm(task);
      tripped = true;
    }
    delete rec.waiting;
    inFlight.delete(rec.runId);
    save();
    // A quiet run reported that nothing happened: it wakes nobody.
    if ((result.status === "ok" || result.status === "failed") && rec.signal !== "quiet") {
      publishRun(task, rec);
    }
    try {
      if (tripped && (task.notify ?? "alerts") !== "off") opts.notify?.(task, rec, "tripped");
      else if (reportNotifies(task.notify, rec)) opts.notify?.(task, rec, "report");
    } catch { /* delivery never changes the run's record */ }
  };

  /** Follow an admitted run to its real end. A stop() detaches the observer
   * without touching the record, so the next start() resumes it. */
  const observe = (task: ScheduleTask, rec: ScheduleRunRecord): Promise<void> => {
    const follower = { signal: observers.signal, watched: follow(task, rec) };
    watching.set(rec.runId, follower);
    const done = (): void => {
      if (watching.get(rec.runId) === follower) watching.delete(rec.runId);
    };
    follower.watched.then(done, done);
    return follower.watched;
  };

  const follow = async (task: ScheduleTask, rec: ScheduleRunRecord): Promise<void> => {
    const signal = observers.signal;
    inFlight.add(rec.runId);
    try {
      const result = await opts.runner.settle!(task, { ...rec }, signal, (waiting) => {
        if (signal.aborted || rec.status !== "running") return;
        if (JSON.stringify(waiting) === JSON.stringify(rec.waiting ?? [])) return;
        if (waiting.length) rec.waiting = waiting;
        else delete rec.waiting;
        save();
      }, (activity, steps) => {
        if (signal.aborted || rec.status !== "running") return;
        rec.activity = activity;
        if (steps > 0) rec.steps = steps;
        saveActivitySoon();
      });
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

  /** `task` owns canonical history/clock state; `executableTask` may be an
   * exact one-shot repository snapshot which must never replace canonical
   * approved prompt/cadence fields. `admitted` resolves once the prompt is
   * accepted (or refused); `settled` once the run's outcome is recorded.
   * `dequeued`: the start was the task's waiting one; the save that records
   * this run removes it, so it is never both waiting and sent. */
  const execute = (
    task: ScheduleTask,
    executableTask: ScheduleTask,
    start: RunStart,
    dequeued = false,
  ): { admitted: Promise<void>; settled: Promise<void> } => {
    const runId = randomUUID();
    const { trigger, late, input, note, attachments, continuation, thread, events, chainDepth } = start;
    // Mark before running so a slow runner can never double-fire. An event
    // wake leaves the schedule's own clock alone; a beat moves only its own.
    if (trigger === "heartbeat") {
      task.lastBeatAt = now();
      task.nextBeatAt = computeNextBeat(task, now());
    } else if (trigger !== "event") {
      task.lastRunAt = now();
      task.runs += 1;
      if (task.cadence.kind === "at") task.enabled = false;
      task.nextRunAt = computeNextRun(task, now());
    }
    task.updatedAt = now();
    const rec: ScheduleRunRecord = {
      runId,
      startedAt: now(),
      status: "running",
      trigger,
      ...(late ? { late: true } : {}),
      ...(input ? { input } : {}),
      ...(note ? { note } : {}),
      ...(attachments?.length ? { attachments: attachmentSummary(attachments) } : {}),
      ...(events?.length ? { events: events.map(describeEvent) } : {}),
      ...(chainDepth ? { chainDepth } : {}),
    };
    const wake: AgentWake = {
      trigger,
      at: rec.startedAt,
      ...(late ? { late: true } : {}),
      ...(input ? { input } : {}),
      ...(note ? { note } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(continuation ? { continuation } : {}),
      ...(thread ? { thread } : {}),
      ...(events?.length ? { events } : {}),
    };
    // Feedback the prompt is about to carry; marked heard once it is admitted.
    const feedbackRuns = pendingFeedback(task.history).map((run) => run.runId);
    if (dequeued) {
      delete task.queuedStart;
      delete task.queued;
    }
    pushHistory(task, rec);
    inFlight.add(runId);
    save();
    const admission = (async (): Promise<boolean> => {
      try {
        const outcome = await opts.runner.run(executableTask, runId, wake);
        for (const run of task.history ?? []) {
          if (run.feedback && feedbackRuns.includes(run.runId)) run.feedback.delivered = true;
        }
        if (outcome?.notebookRev !== undefined) task.notebookSentRev = outcome.notebookRev;
        if (outcome?.sessionId) {
          rec.sessionId = outcome.sessionId;
          task.lastSessionId = outcome.sessionId;
        }
        if (outcome?.markerSeq !== undefined) rec.markerSeq = outcome.markerSeq;
        if (outcome?.queueId) rec.queueId = outcome.queueId;
        if (outcome?.turnId) rec.turnId = outcome.turnId;
        if (outcome?.rotated) rec.rotated = outcome.rotated;
        if (outcome?.backup) rec.backup = outcome.backup;
        if (outcome?.key) rec.key = outcome.key;
        if (outcome?.continued) rec.continued = true;
        if (outcome?.fresh) rec.fresh = outcome.fresh;
        if (outcome?.rollingKey) task.rollingKey = outcome.rollingKey;
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

  const recordSkip = (task: ScheduleTask, error: string): void => {
    pushHistory(task, {
      runId: randomUUID(), startedAt: now(), finishedAt: now(),
      status: "skipped", error,
    });
  };

  /** The person's message: their words and/or files. Only they fill `input`
   *  and `attachments` (an event script's words are its `note`). */
  const personal = (start: RunStart): boolean => Boolean(start.input || start.attachments?.length);

  /** Run `op` after every earlier one for the same task has finished. */
  const serially = <T>(taskId: string, op: () => Promise<T>): Promise<T> => {
    const result = (queueLocks.get(taskId) ?? Promise.resolve()).then(op);
    const done: Promise<void> = result.then(() => {}, () => {});
    queueLocks.set(taskId, done);
    void done.then(() => {
      if (queueLocks.get(taskId) === done) queueLocks.delete(taskId);
    });
    return result;
  };

  /** `admitted`, or the admission bound, whichever comes first: a hung
   *  admission must not hold the agent's message lock for good. */
  const admittedOrLate = (admitted: Promise<void>): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, admissionWaitMs);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    admitted.then(done, done);
  });

  /** A waiting start that may no longer run: removed, with a skip on the
   *  journal that keeps the person's words and says why (one save). */
  const dropWaiting = (task: ScheduleTask, start: RunStart, reason: string): void => {
    delete task.queuedStart;
    delete task.queued;
    pushHistory(task, {
      runId: randomUUID(), startedAt: now(), finishedAt: now(),
      status: "skipped", error: reason, trigger: start.trigger,
      ...(start.input ? { input: start.input } : {}),
      ...(start.note ? { note: start.note } : {}),
      ...(start.attachments?.length ? { attachments: attachmentSummary(start.attachments) } : {}),
    });
    save();
  };

  /** Start `entry` once the task's run in progress (if any) has ended,
   *  unless the service stopped or the wait was replaced meanwhile. A stop
   *  never starts anything: the person's start stays saved for start(). */
  const waitBehind = (task: ScheduleTask, entry: WaitingStart): void => {
    const gen = generation;
    const before = running.get(task.id) ?? Promise.resolve();
    track(task.id, before.then(() => serially(task.id, async () => {
      if (queuedNext.get(task.id) !== entry) return undefined;
      queuedNext.delete(task.id);
      if (gen !== generation || !tasks.includes(task)) return undefined;
      // The same rule as runNow: a repository agent runs only its trusted
      // version, and its file may have changed while the start waited.
      if (entry.executable === task && task.source === "loop-file" && task.trustState !== "trusted-current-version") {
        dropWaiting(task, entry.start, personal(entry.start)
          ? "Not sent: this agent's repository file changed while the message waited, and the new version needs review first."
          : "Not run: this agent's repository file changed while the wake waited, and the new version needs review first.");
        return undefined;
      }
      const run = execute(task, entry.executable, entry.start, true);
      // The next message waits for this one's session, so it can follow it.
      await admittedOrLate(run.admitted);
      return { settled: run.settled };
    })).then((run) => run?.settled));
  };

  /** The saved waiting messages as the page lists them, without targets. */
  const messagesOf = (task: ScheduleTask): AgentQueuedMessage[] =>
    (task.queued ?? []).map(({ sessionId: _sessionId, ...message }) => message);

  /** Wait again for the start saved in `task`: after start(), or for a
   *  message saved while the service was stopped. */
  const resumeWaiting = (task: ScheduleTask): void => {
    if (!task.queuedStart) return;
    const entry: WaitingStart = { start: task.queuedStart, executable: task, messages: messagesOf(task) };
    queuedNext.set(task.id, entry);
    waitBehind(task, entry);
  };

  /** Where a waiting message goes, fixed now (see `ScheduleRunner.thread`). */
  const decideThread = (task: ScheduleTask, start: RunStart): Promise<ThreadTarget | undefined> =>
    opts.runner.thread
      ? opts.runner.thread(task, start.continuation ?? "auto", now()).catch(() => undefined)
      : Promise.resolve(undefined);

  /** Save the waiting start with the page's list of its messages, each
   *  showing where the run will go. */
  const keepWaiting = (task: ScheduleTask, start: RunStart, messages: AgentQueuedMessage[]): void => {
    task.queuedStart = start;
    const sessionId = start.thread?.sessionId;
    task.queued = messages.map((message) => ({ ...message, ...(sessionId ? { sessionId } : {}) }));
    save();
  };

  /** One waiting message, as the agent's page lists it. */
  const queuedMessage = (start: RunStart): AgentQueuedMessage => ({
    text: start.input ?? "",
    at: now(),
    ...(start.attachments?.length ? { attachments: start.attachments.length } : {}),
    ...(start.continuation ? { continuation: start.continuation } : {}),
  });

  /** The person's next message joins the start already waiting: one run
   *  answers both. Their words follow the earlier ones, files add up, and a
   *  later explicit choice of conversation wins. A waiting scheduled wake
   *  becomes the person's run; a waiting event wake stays one (its events,
   *  note and the schedule's clock as they were) and carries their words.
   *  Refuses the message (413) when the run could not carry it whole. */
  const joinStart = (waiting: RunStart, next: RunStart): RunStart => {
    const own = personal(waiting);
    const input = [own ? waiting.input : undefined, next.input].filter(Boolean).join("\n\n");
    if (input.length > INPUT_LIMIT) {
      throw err(`Your messages waiting for this agent would pass ${INPUT_LIMIT} characters together. Send this one once the next run has started.`, "payload-too-large");
    }
    const attachments = [...(own ? waiting.attachments ?? [] : []), ...(next.attachments ?? [])];
    if (attachments.length > MAX_RUN_ATTACHMENTS) {
      throw err(`One run takes at most ${MAX_RUN_ATTACHMENTS} files and the waiting messages would carry ${attachments.length}. Send these once the next run has started.`, "payload-too-large");
    }
    const continuation = next.continuation ?? (own ? waiting.continuation : undefined);
    return {
      trigger: waiting.trigger === "event" ? "event" : "manual",
      ...(waiting.late ? { late: true } : {}),
      ...(input ? { input } : {}),
      ...(waiting.note ? { note: waiting.note } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(continuation ? { continuation } : {}),
      ...(waiting.events?.length ? { events: waiting.events } : {}),
      ...(waiting.chainDepth ? { chainDepth: waiting.chainDepth } : {}),
    };
  };

  /** The person's message runs now, or waits for the run in progress. One
   *  message at a time per agent, so each sees where the one before went.
   *  Where a waiting message goes is fixed when it queues (what the page
   *  promised), and it is saved with the task until its run is recorded. */
  const sendPersonal = (task: ScheduleTask, executable: ScheduleTask, start: RunStart): Promise<void> =>
    serially(task.id, async () => {
      const gen = generation;
      // Stopped, restarting, or a saved start nobody waits on yet (before
      // the first start()): nothing runs ahead of it. The message joins the
      // saved start, which start() sends once the run before it has ended.
      if (paused() || (task.queuedStart && !queuedNext.has(task.id))) {
        const saved = task.queuedStart;
        const joined = saved ? joinStart(saved, start) : start;
        const thread = saved?.thread && !start.continuation ? saved.thread : await decideThread(task, joined);
        keepWaiting(task, { ...joined, ...(thread ? { thread } : {}) }, [...messagesOf(task), queuedMessage(start)]);
        if (phase === "running") resumeWaiting(task);
        return;
      }
      if (!running.get(task.id)) {
        const run = execute(task, executable, start);
        track(task.id, run.settled);
        await admittedOrLate(run.admitted);
        return;
      }
      const waiting = queuedNext.get(task.id);
      if (waiting && waiting.executable !== executable) {
        throw err("A one-off run of this loop's file version waits for the run in progress. Send your message once it has started.", "conflict");
      }
      const joined = waiting ? joinStart(waiting.start, start) : start;
      const entry: WaitingStart = waiting ?? { start, executable, messages: [] };
      // Seen by scheduled wakes, and by a stop(), as the person's while the
      // decision below is read.
      entry.start = joined;
      if (!waiting) queuedNext.set(task.id, entry);
      const kept = waiting && personal(waiting.start) ? waiting.start.thread : undefined;
      const thread = kept && !start.continuation ? kept : await decideThread(task, joined);
      entry.start = { ...joined, ...(thread ? { thread } : {}) };
      entry.messages = [...entry.messages, queuedMessage(start)];
      if (entry.executable === task) keepWaiting(task, entry.start, entry.messages);
      else save();
      if (gen !== generation) {
        // Stopped meanwhile: the saved start waits for start(), or now if
        // that already ran.
        if (phase === "running") resumeWaiting(task);
        return;
      }
      if (!waiting) waitBehind(task, entry);
    });

  /** Fire honoring the overlap policy (default: skip while a run is active).
   * Resolves at admission; a run's own settlement never blocks the tick. */
  const fire = async (
    task: ScheduleTask,
    executableTask: ScheduleTask = task,
    start: RunStart = { trigger: "schedule" },
  ): Promise<void> => {
    // A message from the person is never dropped for being early: it waits
    // for the run in progress.
    if (personal(start)) return sendPersonal(task, executableTask, start);
    if (paused()) {
      // Nothing starts while stopped. A wake the person asked for (a plain
      // wake, or a loop's one-off version) cannot be saved, so it is
      // refused; the clock and waiting events fire after start().
      if (start.trigger === "manual") {
        throw err("Agents are not running right now (Polyth is stopping or restarting them). Try again in a moment.", "unavailable");
      }
      return;
    }
    const policy = task.overlapPolicy ?? "skip";
    const active = running.get(task.id);
    if (active && start.trigger === "heartbeat") {
      // A beat is a glance, not a job: while the agent works, it is skipped
      // without a journal entry.
      task.nextBeatAt = computeNextBeat({ ...task, lastBeatAt: now() }, now());
      save();
      return;
    }
    const waiting = queuedNext.get(task.id);
    if (active && (policy === "skip" || (policy === "queue" && waiting))) {
      recordSkip(task, policy === "skip"
        ? "previous run still active (overlap policy: skip)"
        : "a run is already queued behind the active one (overlap policy: queue)");
      // Still advance the clock so a stuck run does not pile up due-fires.
      if (start.trigger !== "event") task.nextRunAt = computeNextRun({ ...task, lastRunAt: now() }, now());
      save();
      return;
    }
    if (active && policy === "queue") {
      const entry: WaitingStart = { start, executable: executableTask, messages: [] };
      queuedNext.set(task.id, entry);
      waitBehind(task, entry);
      return;
    }
    const run = execute(task, executableTask, start);
    track(task.id, run.settled);
    await run.admitted;
  };

  /** Due time passed long before this tick saw it: Polyth was not running. */
  const missedBy = (task: ScheduleTask, at: number): boolean =>
    task.nextRunAt !== null && at - task.nextRunAt > missedGraceMs;

  const skipMissed = (task: ScheduleTask, at: number): void => {
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

  // ---- event wakes -----------------------------------------------------------
  /** Webhook tokens minted by the last create/update, until the route takes them. */
  const issuedTokens = new Map<string, Record<string, string>>();
  /** Webhook requests per trigger in the current minute (flood guard). */
  const hookHits = new Map<string, { minute: number; count: number }>();
  let eventTimer: ReturnType<typeof setTimeout> | null = null;
  const EVENT_LOG_LIMIT = 30;

  const logEvent = (task: ScheduleTask, entry: AgentEventLogEntry): void => {
    task.eventLog = [entry, ...(task.eventLog ?? [])].slice(0, EVENT_LOG_LIMIT);
  };

  const wakeable = (task: ScheduleTask): boolean =>
    task.enabled && !task.tripped && !task.parseError
    && (task.source !== "loop-file" || task.trustState === "trusted-current-version");

  const agentForSession = (sessionId: string) => {
    for (const task of tasks) {
      const run = task.history?.find((record) => record.sessionId === sessionId);
      if (run || task.lastSessionId === sessionId) {
        return {
          agentId: task.id,
          name: task.title ?? "",
          chainDepth: run?.chainDepth ?? 0,
          ...(run?.trigger ? { trigger: run.trigger } : {}),
          ...(targetModeOf(task) === "existing-session" ? { scheduledMessage: true } : {}),
        };
      }
    }
    return undefined;
  };

  /** Re-arm one timer for the earliest quiet period that ends. */
  const armEvents = (): void => {
    if (eventTimer) clearTimeout(eventTimer);
    eventTimer = null;
    if (phase !== "running") return;
    let due = Infinity;
    for (const task of tasks) {
      for (const state of Object.values(task.paceState ?? {})) {
        if (state.pending.length && state.dueAt !== undefined) due = Math.min(due, state.dueAt);
      }
    }
    if (due === Infinity) return;
    eventTimer = setTimeout(() => { void flushEvents().catch(() => {}); }, Math.max(0, due - now()));
    eventTimer.unref?.();
  };

  const dispatchEvent = (event: AgentEvent): void => {
    let changed = false;
    for (const task of tasks) {
      if (!task.eventTriggers?.length || !wakeable(task)) continue;
      // Session events stay inside their project; agent and integration
      // events inside the Space; a webhook belongs to exactly one agent.
      if (event.kind === "session" && task.projectId !== event.projectId) continue;
      if (event.kind === "webhook" && event.target?.agentId !== task.id) continue;
      if (event.kind === "integration"
        && (task.spaceId !== event.spaceId || (event.projectId && task.projectId !== event.projectId))) continue;
      if (event.kind === "agent") {
        const source = tasks.find((candidate) => candidate.id === event.sourceAgentId);
        if (!source || source.spaceId !== task.spaceId) continue;
      }
      for (const trigger of task.eventTriggers) {
        if (!triggerMatches(trigger, event, task.id)) continue;
        task.paceState = {
          ...task.paceState,
          [trigger.id]: offerEvent(task.paceState?.[trigger.id], event, trigger.pace ?? DEFAULT_PACE, now()),
        };
        changed = true;
      }
    }
    if (!changed) return;
    // Persisted before anything runs: a restart keeps the waiting events.
    save();
    armEvents();
  };

  const publishRun = (task: ScheduleTask, rec: ScheduleRunRecord): void => {
    dispatchEvent({
      id: rec.runId,
      kind: "agent",
      at: rec.finishedAt ?? now(),
      projectId: task.projectId,
      outcome: rec.status === "ok" ? "ok" : "failed",
      sourceAgentId: task.id,
      chainDepth: rec.chainDepth ?? 0,
      fields: {
        agent: task.title ?? "",
        ...(rec.summary ? { summary: rec.summary.slice(0, 600) } : {}),
        ...(rec.error ? { error: rec.error.slice(0, 300) } : {}),
      },
    });
  };

  const flushEvents = async (): Promise<number> => {
    const t0 = now();
    let fired = 0;
    for (const task of tasks) {
      for (const trigger of task.eventTriggers ?? []) {
        // Stopped: the waiting events stay saved for after start().
        if (paused()) return fired;
        const state = task.paceState?.[trigger.id];
        const pace = trigger.pace ?? DEFAULT_PACE;
        const result = settlePace(state, pace, t0);
        if (result.kind === "limited") {
          if (state && !state.limited) {
            logEvent(task, { at: t0, triggerId: trigger.id, outcome: "rate-limited", count: state.pending.length });
            task.paceState![trigger.id] = { ...state, limited: true, dueAt: result.until };
            save();
          }
          continue;
        }
        if (result.kind !== "fire") continue;
        task.paceState![trigger.id] = result.state;
        const count = result.events.length;
        if (!wakeable(task)) {
          save();
          continue;
        }
        const chainDepth = nextChainDepth(result.events);
        if (chainDepth === undefined) {
          logEvent(task, { at: t0, triggerId: trigger.id, outcome: "chain-limit", count, text: `more than ${MAX_CHAIN_DEPTH} agents in a row` });
          save();
          continue;
        }
        let note: string | undefined;
        if (trigger.script) {
          // A script decides; anything but an explicit "run" leaves the agent asleep.
          const scripted: WakeScriptResult = opts.runScript
            ? await opts.runScript(task, trigger.script, result.events)
            : { ok: false, error: "wake scripts are not available" };
          if (paused()) {
            // Stopped while the script ran: its events wait for after start(),
            // with any that arrived meanwhile, saved so a shutdown keeps them
            // — unless the wake (or the agent) was removed meanwhile.
            const current = tasks.includes(task) ? task.eventTriggers?.find((item) => item.id === trigger.id) : undefined;
            if (current) {
              const currentPace = current.pace ?? DEFAULT_PACE;
              const arrived = task.paceState?.[trigger.id]?.pending ?? [];
              task.paceState = {
                ...task.paceState,
                [trigger.id]: arrived.reduce((kept, event) => offerEvent(kept, event, currentPace, now()), state!),
              };
              save();
            }
            return fired;
          }
          if (!scripted.ok) {
            logEvent(task, { at: t0, triggerId: trigger.id, outcome: "script-error", count, text: scripted.error.slice(0, 300) });
            save();
            continue;
          }
          if (scripted.decision.action === "skip") {
            logEvent(task, { at: t0, triggerId: trigger.id, outcome: "script-skip", count, ...(scripted.decision.reason ? { text: scripted.decision.reason.slice(0, 300) } : {}) });
            save();
            continue;
          }
          if (scripted.decision.action === "pause") {
            task.enabled = false;
            disarm(task);
            task.updatedAt = t0;
            logEvent(task, { at: t0, triggerId: trigger.id, outcome: "script-pause", count, ...(scripted.decision.reason ? { text: scripted.decision.reason.slice(0, 300) } : {}) });
            save();
            continue;
          }
          note = scripted.decision.action === "run" ? scripted.decision.note : undefined;
        }
        const overBudget = budgetExceeded(task, t0);
        if (overBudget) {
          task.tripped = { reason: "budget", message: overBudget, at: t0 };
          disarm(task);
          logEvent(task, { at: t0, triggerId: trigger.id, outcome: "budget", count, text: overBudget });
          save();
          continue;
        }
        if (running.size >= maxConcurrent && !running.has(task.id)) {
          logEvent(task, { at: t0, triggerId: trigger.id, outcome: "busy", count });
          save();
          continue;
        }
        logEvent(task, { at: t0, triggerId: trigger.id, outcome: "fired", count });
        await fire(task, task, { trigger: "event", events: result.events, chainDepth, ...(note ? { note } : {}) });
        fired += 1;
      }
    }
    armEvents();
    return fired;
  };

  const receiveWebhook = (token: string, input: { title?: string; event?: string; text: string }): "accepted" | "unknown" | "throttled" => {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return "unknown";
    const hash = webhookTokenHash(token);
    for (const task of tasks) {
      const trigger = task.eventTriggers?.find((candidate) => candidate.kind === "webhook" && candidate.tokenHash === hash);
      if (!trigger) continue;
      const minute = Math.floor(now() / 60_000);
      const key = `${task.id}:${trigger.id}`;
      const hits = hookHits.get(key);
      const count = hits?.minute === minute ? hits.count + 1 : 1;
      hookHits.set(key, { minute, count });
      if (count > WEBHOOK_PER_MINUTE) return "throttled";
      dispatchEvent({
        id: randomUUID(),
        kind: "webhook",
        at: now(),
        projectId: task.projectId,
        outcome: "received",
        target: { agentId: task.id, triggerId: trigger.id },
        chainDepth: 0,
        fields: {
          title: (input.title || "Webhook").slice(0, 160),
          ...(input.event ? { event: input.event.slice(0, 80) } : {}),
          ...(input.text ? { text: input.text.slice(0, WEBHOOK_TEXT_LIMIT) } : {}),
        },
      });
      return "accepted";
    }
    return "unknown";
  };

  return {
    dispatchEvent,
    agentForSession,
    flushEvents,
    receiveWebhook,
    takeIssuedWebhookTokens(id) {
      const issued = issuedTokens.get(id);
      issuedTokens.delete(id);
      return issued ?? {};
    },
    adoptFile(id, spaceId, file) {
      const t = mustGet(id);
      if (!file.loop || !file.digest) throw err("the agent file is not valid", "invalid-input");
      if (tasks.some((other) => other.id !== id && other.projectId === t.projectId && other.source === "loop-file" && other.loopId === file.loop!.id)) {
        throw err(`another agent already uses the id "${file.loop.id}"`, "conflict");
      }
      t.source = "loop-file";
      t.sourcePath = file.path;
      t.sourceDigest = file.digest;
      t.loopId = file.loop.id;
      // The person just wrote exactly these bytes from this agent: trust them.
      t.trustReceipt = issueContentTrustReceipt(trustSubject(t, file, spaceId), "current-version", now());
      t.trustState = "trusted-current-version";
      delete t.pendingVersion;
      delete t.rejectedSourceDigest;
      delete t.parseError;
      applyLoopExecutable(t, file.loop);
      t.enabledOverride = t.enabled;
      rearm(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    resetSession(id) {
      const t = mustGet(id);
      delete t.lastSessionId;
      delete t.rollingKey;
      t.updatedAt = now();
      save();
      return t;
    },
    recordWarm(id, at) {
      const t = mustGet(id);
      t.warmPings = [...(t.warmPings ?? []).filter((ping) => ping > at - 24 * 60 * 60_000), at].slice(-200);
      save();
    },
    isRunning(id) {
      return running.has(id);
    },
    requestStop(id) {
      const t = mustGet(id);
      const live = (t.history ?? []).filter((run) => run.status === "running" && run.sessionId);
      for (const run of live) run.stopped = true;
      if (live.length) save();
      return live.map((run) => run.sessionId!);
    },
    markSeen(id, at) {
      const t = mustGet(id);
      const seen = Math.min(at ?? now(), now());
      if (seen > (t.seenAt ?? 0)) {
        t.seenAt = seen;
        save();
      }
      return t;
    },
    setFeedback(id, runId, feedback) {
      const t = mustGet(id);
      const run = t.history?.find((record) => record.runId === runId);
      if (!run) throw err("run not found", "not-found");
      if (feedback === null) delete run.feedback;
      else {
        if (feedback.verdict !== "up" && feedback.verdict !== "down") throw err("verdict must be up or down");
        const note = typeof feedback.note === "string" ? feedback.note.replace(/\s+/g, " ").trim().slice(0, FEEDBACK_NOTE_LIMIT) : "";
        run.feedback = { verdict: feedback.verdict, ...(note ? { note } : {}), at: now() };
      }
      t.updatedAt = now();
      save();
      return t;
    },
    subscribed(source) {
      const out = new Map<string, { spaceId: string; projectId: string }>();
      for (const task of tasks) {
        if (!task.spaceId || !wakeable(task)) continue;
        if (task.eventTriggers?.some((trigger) => trigger.kind === "integration" && trigger.source === source)) {
          out.set(`${task.spaceId}:${task.projectId}`, { spaceId: task.spaceId, projectId: task.projectId });
        }
      }
      return [...out.values()];
    },
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
        ...(spaceId ? { spaceId } : {}),
        ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.target ? { target: input.target } : {}),
        ...(input.overlapPolicy ? { overlapPolicy: input.overlapPolicy } : {}),
        ...(input.catchUp ? { catchUp: input.catchUp } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
      };
      const issued = applyAgentFields(t, input);
      if (Object.keys(issued).length) issuedTokens.set(t.id, issued);
      mirrorCadence(t);
      assertHeartbeatContext(t);
      if (input.notebook !== undefined) writeNotebook(t, input.notebook, now());
      rearm(t, now());
      tasks.push(t);
      save();
      return t;
    },
    update(id, patch) {
      const t = mustGet(id);
      if (t.source === "loop-file") {
        // The file is the definition: only pausing is local.
        // The notebook is the agent's own state, not its definition.
        const local = new Set(["enabled", "spaceId", "projectId", "notebook"]);
        const edited = Object.entries(patch).some(([key, value]) => value !== undefined && !local.has(key));
        if (edited || (patch.projectId !== undefined && patch.projectId !== t.projectId)) {
          throw err(`this agent is managed by ${t.sourcePath ?? "a repository file"}; edit the file instead`, "conflict");
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
      const probe = structuredClone(t);
      applyAgentFields(probe, patch); // validate before mutating anything
      assertHeartbeatContext({ heartbeat: probe.heartbeat, target: patch.target ?? t.target, sessionId: merged.sessionId });
      if (merged.projectId !== t.projectId) {
        const spaceId = patch.spaceId ?? opts.spaceOf?.(merged.projectId);
        if (spaceId) t.spaceId = spaceId;
        else delete t.spaceId;
      }
      t.projectId = merged.projectId;
      t.prompt = merged.prompt.trim();
      t.cadence = cadence;
      mirrorCadence(t);
      if (merged.sessionId !== undefined) t.sessionId = merged.sessionId;
      if (merged.title !== undefined) t.title = merged.title;
      if (patch.target !== undefined) t.target = patch.target;
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
      const issued = applyAgentFields(t, patch);
      if (Object.keys(issued).length) issuedTokens.set(t.id, issued);
      t.enabled = merged.enabled ?? true;
      if (cadence.kind === "at" && (patch.kind !== undefined || patch.at !== undefined || patch.cadence !== undefined)) {
        t.runs = 0; // re-arm one-shots on reschedule
      }
      if (patch.notebook !== undefined) writeNotebook(t, patch.notebook, now());
      rearm(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    remove(id) {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      queuedNext.delete(id);
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
      // Resuming is the explicit decision a tripped agent waits for.
      if (enabled) delete t.tripped;
      if (enabled && t.cadence.kind === "at") t.runs = 0; // re-enable re-arms the one-shot
      rearm(t, now());
      t.updatedAt = now();
      save();
      return t;
    },
    async runNow(id, runOpts) {
      const t = mustGet(id);
      if (t.source === "loop-file" && t.trustState !== "trusted-current-version") {
        throw err("this repository-managed loop version is blocked pending trust", "content-trust-required");
      }
      const input = runOpts?.input?.trim().slice(0, INPUT_LIMIT);
      const attachments = validateRunAttachments(runOpts?.attachments);
      const continuation = runOpts?.continuation;
      if (continuation !== undefined && !isAgentContinuation(continuation)) throw err("continuation must be auto, continue or new");
      if (continuation === "new" && targetModeOf(t) === "existing-session") {
        throw err("This agent always works in the session chosen for it, so a message cannot start a new conversation.");
      }
      await fire(t, t, {
        trigger: "manual",
        ...(input ? { input } : {}),
        ...(attachments.length ? { attachments } : {}),
        // `auto` is the default, not a choice: it never overrides one.
        ...(continuation && continuation !== "auto" ? { continuation } : {}),
      });
      return t;
    },
    async tick() {
      // Stopped: due runs fire after start(); their clocks did not move.
      if (paused()) return 0;
      const t0 = now();
      // A budget trip lifts by itself once the 24-hour window has room again.
      for (const t of tasks) {
        if (t.tripped?.reason !== "budget" || budgetExceeded(t, t0)) continue;
        delete t.tripped;
        rearm(t, t0);
        t.updatedAt = t0;
        save();
      }
      const due = tasks.filter((t) => t.enabled && !t.parseError && !t.tripped
        && (t.source !== "loop-file" || t.trustState === "trusted-current-version")
        && t.nextRunAt !== null && t.nextRunAt <= t0);
      let fired = 0;
      for (const t of due) {
        if (paused()) return fired;
        const late = missedBy(t, t0);
        if (late && t.catchUp === "skip") {
          skipMissed(t, t0);
          continue;
        }
        const overBudget = budgetExceeded(t, t0);
        if (overBudget) {
          t.tripped = { reason: "budget", message: overBudget, at: t0 };
          recordSkip(t, overBudget);
          disarm(t);
          t.updatedAt = t0;
          save();
          continue;
        }
        if (running.size >= maxConcurrent && !running.has(t.id)) {
          recordSkip(t, `${running.size} agent runs already in progress; skipped to protect the host.`);
          t.nextRunAt = computeNextRun({ ...t, lastRunAt: t0 }, t0);
          save();
          continue;
        }
        await fire(t, t, { trigger: "schedule", ...(late ? { late: true } : {}) });
        fired += 1;
      }
      // Heartbeats: light checks inside the rolling conversation. A beat
      // missed while Polyth was down is not caught up; the next one is.
      for (const t of tasks) {
        if (paused()) return fired;
        if (!t.heartbeat || typeof t.nextBeatAt !== "number" || t.nextBeatAt > t0 || !wakeable(t)) continue;
        const overBudget = budgetExceeded(t, t0);
        if (overBudget) {
          t.tripped = { reason: "budget", message: overBudget, at: t0 };
          disarm(t);
          t.updatedAt = t0;
          save();
          continue;
        }
        // A beat is a glance: while the agent works, or the host is at its
        // limit, it moves on to the next one without a journal entry.
        if (running.has(t.id) || running.size >= maxConcurrent) {
          t.nextBeatAt = computeNextBeat({ ...t, lastBeatAt: t0 }, t0);
          save();
          continue;
        }
        await fire(t, t, { trigger: "heartbeat" });
        fired += 1;
      }
      return fired;
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
                disarm(existing);
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
          const spaceId = opts.spaceOf?.(projectId);
          t = {
            id: randomUUID(),
            projectId,
            ...(spaceId ? { spaceId } : {}),
            prompt: loop.prompt,
            kind: "cron",
            cadence: loop.cron
              ? { kind: "cron", expression: loop.cron, timeZone: loop.timeZone }
              : { kind: "every", everyMinutes: 60 },
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
          // Before the first approval the file's own settings are shown as-is.
          if (loop.file) applyLoopExecutable(t, loop);
          mirrorCadence(t);
          tasks.push(t);
          continue;
        }

        const fields = changedLoopFields(t, loop, file.path);
        const currentSubject: ContentTrustSubject = {
          spaceId: t.trustReceipt?.spaceId ?? "__untrusted__",
          projectId,
          sourceKind: sourceKindOf(file.path),
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
          rearm(t, now());
        } else {
          // Before the first approval there is no trusted snapshot to preserve,
          // so current parsed content may be displayed. Once a receipt exists,
          // repository changes NEVER replace that executable snapshot.
          if (!t.trustReceipt) applyLoopExecutable(t, loop);
          t.trustState = t.trustReceipt ? "changed-since-trust" : "untrusted";
          t.pendingVersion = observedPending(file, now(), fields);
          if (t.rejectedSourceDigest !== file.digest) delete t.rejectedSourceDigest;
          t.enabled = false;
          disarm(t);
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
      rearm(t, now());
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
      const executable: ScheduleTask = structuredClone(t);
      applyLoopExecutable(executable, file.loop);
      Object.assign(executable, {
        enabled: true,
        sourceDigest: file.digest,
        trustReceipt: issueContentTrustReceipt(trustSubject(t, file, spaceId), "once", now()),
        trustState: "trusted-current-version",
      });
      await fire(t, executable, { trigger: "manual" });
      // Persistent authorization and executable fields remain exactly as they
      // were before this one-shot execution.
      t.enabled = false;
      disarm(t);
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
      disarm(t);
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
    assignSpaces() {
      const moved = assignSpaces();
      if (moved) save();
      return moved;
    },
    start() {
      if (phase === "running" || phase === "starting") return;
      const gen = generation;
      // Only a stop() released observers; live ones (a start from `idle`)
      // keep following under their controller.
      const released = observers.signal.aborted;
      if (released) observers = new AbortController();
      phase = "starting";
      const begin = (): void => {
        // A stop() meanwhile cancels this start.
        if (gen !== generation || phase !== "starting") return;
        phase = "running";
        // Runs left `running` by a previous process (or a previous enable):
        // resume following an admitted turn; a run that never confirmed its
        // admission cannot be followed and is never replayed. A run still in
        // admission (`inFlight`) follows itself once admitted.
        let changed = false;
        for (const t of tasks) {
          for (const rec of t.history ?? []) {
            if (rec.status !== "running") continue;
            const letting = watching.get(rec.runId);
            if (letting?.signal.aborted) {
              // Its released observer is still letting go past the wait: the
              // run is followed again once it has, and counts as at work
              // meanwhile, so nothing saved goes ahead of it.
              track(t.id, letting.watched.then(() => {
                if (phase !== "running" || rec.status !== "running") return undefined;
                // Another restart's chain may have followed it first: wait
                // for that follower instead.
                return inFlight.has(rec.runId) ? watching.get(rec.runId)?.watched : observe(t, rec);
              }));
              continue;
            }
            if (inFlight.has(rec.runId)) continue;
            if (opts.runner.settle && rec.sessionId) {
              track(t.id, observe(t, rec));
            } else {
              rec.status = "unknown";
              rec.finishedAt = now();
              rec.error = "Polyth stopped before this run's result was confirmed.";
              delete rec.activity;
              t.lastError = rec.error;
              changed = true;
            }
          }
        }
        if (changed) save();
        // The person's messages saved while a run worked or the service was
        // stopped: they wait for the resumed run, or start now. Never
        // dispatched yet, so this sends them once; it replays nothing.
        for (const t of tasks) resumeWaiting(t);
        armEvents();
        timer = setInterval(() => {
          void this.tick().catch(() => {});
        }, tickMs);
        timer.unref?.();
      };
      // Observers a stop() released may still be letting go of their runs
      // (and of `inFlight`): reconcile once they have, so each such run is
      // followed again from its session instead of being skipped.
      const releasing = released
        ? [...watching.values()].filter((follower) => follower.signal.aborted).map((follower) => follower.watched)
        : [];
      if (!releasing.length) {
        begin();
        return;
      }
      let bound: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([
        Promise.allSettled(releasing),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, opts.releaseWaitMs ?? RELEASE_WAIT_MS);
          bound.unref?.();
        }),
      ]).then(() => {
        clearTimeout(bound);
        begin();
      });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      phase = "stopped";
      if (eventTimer) clearTimeout(eventTimer);
      eventTimer = null;
      // The newest step is in memory; the next save (or start) writes it.
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = null;
      // Nothing waiting starts now: the observers' release ends the runs
      // they wait for early. The person's starts stay saved for start();
      // a wake that waited in memory only is gone, and says so.
      generation += 1;
      let dropped = false;
      for (const [taskId, entry] of queuedNext) {
        const task = tasks.find((t) => t.id === taskId);
        // The person's start is saved (or about to be, mid-queueing).
        if (!task || (entry.executable === task && (task.queuedStart || personal(entry.start)))) continue;
        const { trigger, events } = entry.start;
        pushHistory(task, {
          runId: randomUUID(), startedAt: now(), finishedAt: now(), status: "skipped", trigger,
          error: "Not run: Polyth stopped the agents before this queued wake could start.",
          ...(events?.length ? { events: events.map(describeEvent) } : {}),
        });
        dropped = true;
      }
      queuedNext.clear();
      if (dropped) save();
      observers.abort();
    },
  };
}

/** Schema of the saved documents. 5: an event run's script note is its
 *  `note`, no longer its `input`. */
const SCHEMA_VERSION = 5;

/** Before schema 5 an event run kept its script's note in `input`. Moves it
 *  to `note`; returns how many records moved. */
function moveScriptNotes(tasks: readonly ScheduleTask[]): number {
  let moved = 0;
  for (const t of tasks) {
    for (const run of t.history ?? []) {
      if (run.trigger !== "event" || run.note !== undefined || typeof run.input !== "string") continue;
      run.note = run.input;
      delete run.input;
      moved += 1;
    }
  }
  return moved;
}

/** A saved document. `migrated`: it predates the current schema and loading
 *  changed it, so it should be saved again (once). */
function load(file: string): { tasks: ScheduleTask[]; loopErrors: Record<string, ScheduleLoopError[]>; migrated: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      v?: unknown;
      tasks?: ScheduleTask[];
      loopErrors?: Record<string, ScheduleLoopError[]>;
    };
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const current = typeof parsed.v === "number" && parsed.v >= SCHEMA_VERSION;
    return {
      tasks,
      loopErrors: parsed.loopErrors && typeof parsed.loopErrors === "object" ? parsed.loopErrors : {},
      migrated: !current && moveScriptNotes(tasks) > 0,
    };
  } catch {
    return { tasks: [], loopErrors: {}, migrated: false };
  }
}
