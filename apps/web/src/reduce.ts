// DOM-free event → render-model reducer. Pure data in, pure data out; used by
// the store, the views and tests. Replaying the same event list in order
// reconstructs an identical model (session log invariant).
import type {
  AttachmentRef,
  FusionDto,
  FusionWeightDto,
  JsonObject,
  ModelRef,
  MultirunDto,
  MultirunRunDto,
  RateLimitScope,
  RuntimeFeaturesDto,
  SessionEvent,
  SessionPerson,
  TokenUsage,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import { normalizeSessionPerson } from "@polyth/contracts";
import { extractChangedFiles } from "./pendingChanges.ts";
import { normalizeQuestions, questionAnswerDraft, type AnswerMap } from "./questionSerializers.ts";
import { tr } from "./i18n/index.ts";
import { runWebReducers } from "./packages/reducers.ts";
import { stripRecoveryContextBlocks } from "./recoveryDisplay.ts";

export interface UserMsg {
  kind: "user";
  id: string;
  eventSeq: number;
  text: string;
  raw?: string;
  attachments?: AttachmentRef[];
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  /** Who wrote it, in a session several people share. Absent on messages
   *  recorded before authorship and on agent/system prompts. */
  author?: SessionPerson;
  /** Prior-epoch turn-submit whose outcome stayed unknown or was fenced. */
  uncertain?: boolean;
  /** Mutation counter: reduceEvent updates messages IN PLACE, so identity
   *  checks can't see changes. Every in-place mutation bumps `rev`; row
   *  memoization captures it as a scalar prop at render time. */
  rev?: number;
}

export interface AssistantMsg {
  kind: "assistant";
  id: string; // partId
  partId: string;
  eventSeq: number;
  text: string;
  reasoning: string;
  /** Wall-clock bounds of the reasoning stream (first/last reasoning chunk),
   *  used by the collapsed "Thought for …" label. Absent when the log carries
   *  only a final assistant/message with pre-merged reasoning. */
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  finalized: boolean; // assistant/message seen
  model?: ModelRef;
  agent?: string;
  harnessId?: string;
  runtimeLegId?: string;
  profileId?: string;
  tokens?: TokenUsage;
  cost?: number;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  /** Final `assistant/message.time` — the semantic completion time, distinct
   *  from `time` (the first streamed chunk) */
  completedAt?: number;
  /** The provider's own limit line ("You've hit your limit · resets …") that
   *  closed a rate-limited turn. The resume notice says the same, so the
   *  timeline does not render it as an answer. */
  providerNotice?: true;
  /** See UserMsg.rev. */
  rev?: number;
}

export interface ToolMsg {
  kind: "tool";
  id: string; // callId
  callId: string;
  eventSeq: number;
  tool: string;
  input: JsonObject;
  output?: string;
  error?: string;
  title?: string;
  metadata?: JsonObject;
  /** `pending` is queued but not started; `running` begins at `tool/started`. */
  status: "pending" | "running" | "done" | "error";
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  finishTime?: number;
  changedFiles?: string[];
  /** A command the person ran from the composer with `!`: its own timeline
   *  row, never part of an agent's activity block. */
  composerShell?: boolean;
  /** See UserMsg.rev. */
  rev?: number;
}

export interface TaskActivityMsg {
  kind: "task";
  id: string;
  eventSeq: number;
  taskId: string;
  text: string;
  action: "created" | "started" | "completed" | "failed";
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  /** See UserMsg.rev. */
  rev?: number;
}

export interface GithubConflictMsg {
  kind: "github-conflict";
  id: string;
  eventSeq: number;
  prNumber: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  /** See UserMsg.rev. */
  rev?: number;
}

export interface NoticeMsg {
  kind: "notice";
  id: string;
  eventSeq: number;
  topic: "isolation-merged" | "isolation-discarded" | "isolation-started";
  branch?: string;
  commit?: string;
  /** Isolation started: uncommitted paths left in the original checkout. */
  uncommitted?: number;
  /** A discard that left an unchanged isolation: nothing was thrown away. */
  returned?: boolean;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  rev?: number;
}

/** An agent's question and the person's reply, kept in the conversation at
 *  the point it was asked. `eventSeq` is the ask; `answeredSeq` is the reply,
 *  which is the rewind point that lets the answer be edited like a prompt. */
export interface QuestionMsg {
  kind: "question";
  id: string;
  eventSeq: number;
  requestId: string;
  questions: JsonObject[];
  status: "pending" | "answered" | "rejected";
  answers?: JsonObject;
  answeredSeq?: number;
  answeredAt?: number;
  /** Set on a parent's mirror of a subagent's question: the child that asked. */
  sourceSessionId?: string;
  /** The active (or replaced) rewind that cut this answer off. */
  answerRewindMarkerSeq?: number;
  /** The rewound answer was replaced by a later message. */
  answerReplaced?: boolean;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  rev?: number;
}

/** People talking to people in a session. Never a prompt, never agent
 *  activity and never model-visible (except an explicit `carryToAgent`). */
export interface PersonMessageMsg {
  kind: "person-message";
  id: string;
  eventSeq: number;
  text: string;
  author?: SessionPerson;
  mentions: SessionPerson[];
  carryToAgent?: boolean;
  /** A carried message a later prompt has already handed to the agent. */
  delivered?: boolean;
  /** Same author as the message just before, within a few minutes: the row
   *  drops its repeated name. */
  continuation?: boolean;
  /** The next message continues this one's run: only the run's last bubble
   *  carries the tail and the author's mark. */
  continued?: boolean;
  /** The first message, or the first after a quiet stretch or a new day:
   *  a centered time divider opens it. */
  timeBreak?: boolean;
  replyToSeq?: number;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  rev?: number;
}

/** Consecutive person messages from one author group under one header. */
const PERSON_MESSAGE_GROUP_MS = 5 * 60_000;
/** A quiet stretch this long between people's messages earns a time divider. */
const PERSON_MESSAGE_BREAK_MS = 15 * 60_000;

const sameLocalDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/** An agent session started from this conversation; rendered as a link card. */
export interface ConversationStartedMsg {
  kind: "conversation-started";
  id: string;
  eventSeq: number;
  sessionId: string;
  title: string;
  sourceSeqs: number[];
  startedBy?: SessionPerson;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  rev?: number;
}

export type RenderMessage = UserMsg | AssistantMsg | ToolMsg | TaskActivityMsg | GithubConflictMsg | NoticeMsg | QuestionMsg | PersonMessageMsg | ConversationStartedMsg;

export interface PendingPermission {
  sessionId: string;
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: string;
  status: "pending" | "resolved";
  reply?: "once" | "always" | "reject";
  /** Resolved by the session's auto-accept policy, not a human click. */
  auto?: boolean;
  /** A composer-shell confirmation for the user's own command. No automatic
   *  policy answers it, Full access included. */
  manual?: boolean;
  time: number;
  /** Server-generated, secret-redacted preview (old events lack it).
   *  `reasons` are stable codes for a high risk; Auto-Approve never answers
   *  such a request, so a person sees it even while Auto-Approve is on. */
  preview?: {
    title: string;
    lines: string[];
    risk?: "low" | "medium" | "high";
    reasons?: string[];
    /** Auto-Approve's Judgment second opinion held the request (`outside-task`): its chance, 0..1. */
    scopeCheck?: { probability: number };
  };
  allowedScopes?: Array<"once" | "session" | "project">;
  /** Set on a parent's mirror of a subagent's request: the child that asked. */
  sourceSessionId?: string;
  /** A person handed this request to the parent session's agent. */
  delegated?: boolean;
}

export interface PendingQuestion {
  sessionId: string;
  requestId: string;
  questions: JsonObject[];
  status: "pending" | "answered" | "rejected";
  answers?: JsonObject;
  time: number;
}

export interface PendingSecret {
  sessionId: string;
  requestId: string;
  handle: string;
  label: string;
  purpose?: string;
  kind?: string;
  existing?: boolean;
  status: "pending" | "resolved";
  action?: "saved" | "dismissed";
  time: number;
}

export type GoalVerdict = "keep" | "done" | "stuck";

export interface GoalState {
  objective: string;
  status: "active" | "paused" | "completed" | "stuck" | "stopped";
  continuations: number;
  maxContinuations: number;
  tokensUsed: number;
  budgetTokens: number;
  lastVerdict?: GoalVerdict;
  lastReason?: string;
  stuckStreak: number;
  updatedAt: number;
  waitingFor?: string[];
  auditRevision?: string;
}

export interface Totals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ContextUsageState {
  /** Fresh (uncached) input tokens of the most recent request. */
  inputTokens: number;
  /** Cached prompt tokens read back on the most recent request. */
  cacheReadTokens: number;
  /** Prompt tokens written to the cache on the most recent request. */
  cacheWriteTokens: number;
  model?: ModelRef;
  harnessId?: string;
}

export type ContextGauge =
  | {
      known: true;
      inputTokens: number;
      contextTokens: number;
      percent: number;
      level: "green" | "yellow" | "red";
      quality: "native" | "derived" | "estimated";
    }
  | {
      known: false;
      inputTokens: number;
      contextTokens: number | null;
      percent: number | null;
      level: "unknown" | "fraction";
      quality?: "native" | "derived" | "estimated" | "unknown" | "fraction";
      /** Explicitly false when telemetry supplies only a limit or fraction. */
      hasTokenCount?: false;
    };

/** Provider capacity stop with a scheduled server-side auto-resume. Present
 *  on a failed turn only while the wait is pending; cleared when the resend
 *  starts or the user cancels. */
export interface TurnLimitState {
  scope: RateLimitScope;
  provider?: string;
  /** Provider-advised wait in seconds, when the error carried one. */
  retryAfterSec?: number;
  /** ms epoch the server will resend the last message. Absent when the stop is
   *  not auto-resumable and only a model switch can clear it. */
  resumeAt?: number;
  /** 1 on the first hit for this message, higher on repeats. */
  attempt: number;
  /** Bounded retry program: the server stops auto-resending after this many
   *  attempts and the stop settles as an ordinary failure. */
  maxAttempts?: number;
  /** Structured provider refusal that waiting cannot clear. */
  code?: "model-unavailable" | "quota-exhausted";
}

export interface TurnState {
  turnId: string;
  status: "working" | "stopped" | "aborted" | "failed";
  model?: ModelRef;
  agent?: string;
  harnessId?: string;
  runtimeLegId?: string;
  profileId?: string;
  reason?: string;
  error?: string;
  /** Set when `status === "failed"` because the provider is rate-limited. */
  limit?: TurnLimitState;
  /** The stop was a provider limit/refusal. Outlives `limit` (a cancelled
   *  wait or model/harness switch clears that), so the turn never falls back
   *  to the generic failure notice. */
  providerLimited?: true;
  /** Event-derived wall-clock bounds of THIS turn: the footer
   *  duration is `stoppedAt - startedAt`, absent while working or when a
   *  copied/unmatched stop carries no start. */
  startedAt?: number;
  stoppedAt?: number;
  /** This turn's own usage, separate from lifetime totals — a branch child
   *  must not combine inherited totals with a zero-duration pseudo-turn. */
  usage?: { tokens: TokenUsage; cost: number };
}

/** Editable seed carried by an active rewind or a per-message fork marker. */
export interface SeedDraft {
  text: string;
  attachments?: AttachmentRef[];
}

/** Lineage/draft state owned by a `session/forked` marker (per-message fork).
 *  `seedConsumed` flips when a child-origin user/message lands after the
 *  marker, so reload seeds the composer at most once. */
export interface ForkState {
  fromSessionId: string;
  markerSeq: number;
  sourceAtSeq?: number;
  draft?: SeedDraft;
  seedConsumed: boolean;
}

export interface TaskListState {
  listId: string;
  revision: number;
  items: Array<{ id: string; text: string; status: "pending" | "active" | "done" | "failed" }>;
}

export interface SubagentState {
  revision: number;
  agents: Array<{ sessionId: string; label: string; status: string; currentTask?: string }>;
}

export interface RenderModel {
  messages: RenderMessage[];
  permissions: PendingPermission[];
  questions: PendingQuestion[];
  secrets: PendingSecret[];
  totals: Totals;
  /** Latest usage sample for the active/last turn; model selection metadata. */
  contextUsage: ContextUsageState | null;
  /** Compacted history stays visible, but is no longer a resident-text estimate. */
  contextEstimateAfterSeq?: number;
  /** Occupancy older than this canonical boundary belongs to the previous context. */
  contextResetAt?: number;
  /** Context-pressure level the server last told the model about since the
   *  latest compaction (user/message `contextPressure`). */
  contextPressureLevel?: number;
  turn: TurnState | null;
  goal: GoalState | null;
  multirun: MultirunDto | null;
  workflowRun: WorkflowRunDto | null;
  /** Sequence of the run's `workflow/run-started`: the card's place in history. */
  workflowRunSeq?: number;
  fusion: FusionDto | null;
  fusionPrompt: string;
  /** Latest revisioned task/subagent snapshots; replay-deterministic. */
  tasks: TaskListState | null;
  subagents: SubagentState | null;
  /** Edit-tool paths from the current/last turn; cleared by the next prompt. */
  changedFiles: string[];
  /** The latest canonical user/message was intentionally omitted from chat. */
  lastUserMessageHidden: boolean;
  /** A prompt-cache keep-alive turn is open (`user/message.keepAlive`): its
   *  prompt, turn boundaries and reply are maintenance, not conversation, so
   *  they stay out of the chat; its usage still updates context and totals. */
  keepAliveTurn?: boolean;
  /** Active rewind marker. `draft` is replay-derived from the target
   *  `user/message` (raw ?? text + attachments); `restoredText` only appears
   *  when an old marker carried it (compat). */
  rewind: { markerSeq: number; atSeq: number; restoredText?: string; draft?: SeedDraft } | null;
  /** Lineage of a `session/forked` child (per-message forks carry a draft). */
  fork: ForkState | null;
  version: number; // bumps on every applied event (cheap change signal)
  /** Bumps only on queue-affecting events (queue/*, delivery/fallback-queued)
   *  so the queue badge refetches per queue change, not per streamed chunk. */
  queueVersion: number;
}

export function emptyModel(): RenderModel {
  return {
    messages: [],
    permissions: [],
    questions: [],
    secrets: [],
    totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextUsage: null,
    turn: null,
    goal: null,
    multirun: null,
    workflowRun: null,
    fusion: null,
    fusionPrompt: "",
    tasks: null,
    subagents: null,
    changedFiles: [],
    lastUserMessageHidden: false,
    rewind: null,
    fork: null,
    version: 0,
    queueVersion: 0,
  };
}

const roughTextTokens = (text: string): number => {
  let ascii = 0;
  let wide = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x7f) ascii += 1;
    else if (
      (code >= 0x3000 && code <= 0x9fff)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0x1f300 && code <= 0x1faff)
    ) wide += 1;
    else other += 1;
  }
  // Four ASCII characters per token is the usual cross-provider approximation;
  // CJK/emoji are closer to one token per glyph. This is intentionally a
  // provider-neutral lower-bound estimate used only until native usage arrives.
  return Math.ceil(ascii / 4 + wide + other / 2);
};

/** Estimated model-visible content when a harness has not reported usage yet.
 * Tool inputs/results count because the next native request carries them;
 * task projections are excluded because their originating tool call is already
 * represented. Hidden system prompts and provider-only framing remain unknown. */
export function estimatedContextTokens(messages: readonly RenderMessage[], afterSeq = 0): number {
  let tokens = 0;
  for (const message of messages) {
    if (message.undone || message.eventSeq <= afterSeq) continue;
    if (message.kind === "user") {
      tokens += 4 + roughTextTokens(message.text);
      for (const attachment of message.attachments ?? []) tokens += roughTextTokens(attachment.name);
    } else if (message.kind === "assistant") {
      tokens += 4 + roughTextTokens(message.text) + roughTextTokens(message.reasoning);
    } else if (message.kind === "tool") {
      let input = "";
      try { input = JSON.stringify(message.input) ?? ""; } catch { input = ""; }
      tokens += 4 + roughTextTokens(input) + roughTextTokens(message.output ?? "") + roughTextTokens(message.error ?? "");
    } else if (message.kind === "github-conflict") {
      tokens += 4 + roughTextTokens(`${message.title}\n${message.url}\n${message.baseRefName}\n${message.headRefName}`);
    }
  }
  return tokens;
}

/** Tokens resident in the model's context window right now, taken from the
 *  latest usage sample: the prompt footprint of the most recent request
 *  (fresh input + cached input read + cache-creation input). This is NOT
 *  `totals.input`, which sums every request's input and therefore counts the
 *  resent conversation history once per turn — that running total blows past
 *  the context window even when the live context is nearly empty. */
const nonNegativeFinite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const contextEstimateCache = new WeakMap<object, { version: number; tokens: number }>();

export function contextTokensUsed(model: Partial<Pick<RenderModel, "contextUsage" | "messages" | "version" | "contextEstimateAfterSeq">>): number {
  const u = model.contextUsage;
  if (u) return nonNegativeFinite(u.inputTokens)
    + nonNegativeFinite(u.cacheReadTokens)
    + nonNegativeFinite(u.cacheWriteTokens);
  if (!model.messages) return 0;
  if (typeof model.version !== "number") return estimatedContextTokens(model.messages, model.contextEstimateAfterSeq);
  const cached = contextEstimateCache.get(model);
  if (cached?.version === model.version) return cached.tokens;
  const tokens = estimatedContextTokens(model.messages, model.contextEstimateAfterSeq);
  contextEstimateCache.set(model, { version: model.version, tokens });
  return tokens;
}

export interface ContextIdentity { model?: ModelRef; harnessId?: string }
const sameContextModel = (a: ModelRef, b: ModelRef): boolean =>
  a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant;

export function contextGauge(
  model: Partial<Pick<RenderModel, "contextUsage" | "totals" | "messages" | "version" | "contextEstimateAfterSeq" | "contextResetAt">>,
  contextTokens?: number,
  occupancy?: { limitTokens?: number; usedTokens?: number; fraction?: number; source?: string; updatedAt?: number; harnessId?: string; model?: ModelRef } | null,
  identity?: ContextIdentity,
): ContextGauge {
  const usage = model.contextUsage;
  const mismatchedUsageModel = usage?.model && identity?.model && !sameContextModel(usage.model, identity.model);
  const mismatchedUsageHarness = usage?.harnessId && identity?.harnessId && usage.harnessId !== identity.harnessId;
  if (mismatchedUsageModel || mismatchedUsageHarness) {
    model = { ...model, contextUsage: null };
  }
  // Each source owns its identity. A rejected usage sample says nothing about
  // a newer occupancy update, and stale occupancy cannot erase valid usage.
  const mismatchedOccupancyModel = occupancy?.model && identity?.model && !sameContextModel(occupancy.model, identity.model);
  const mismatchedOccupancyHarness = occupancy?.harnessId && identity?.harnessId && occupancy.harnessId !== identity.harnessId;
  if (mismatchedOccupancyModel || mismatchedOccupancyHarness) occupancy = null;
  if (model.contextResetAt !== undefined && occupancy?.updatedAt !== undefined
    && occupancy.updatedAt < model.contextResetAt) occupancy = null;
  // After an acknowledged compaction the live projection intentionally says
  // unknown. Only new canonical visible text may supply a lower-bound estimate.
  if (occupancy?.source === "unknown" && occupancy.fraction === undefined
    && model.contextEstimateAfterSeq !== undefined) occupancy = null;
  if (occupancy?.source === "unknown") {
    return {
      known: false,
      inputTokens: occupancy.usedTokens ?? 0,
      contextTokens: occupancy.limitTokens ?? null,
      percent: occupancy.fraction !== undefined ? Math.min(100, Math.max(0, Math.round(occupancy.fraction * 100))) : null,
      level: occupancy.fraction !== undefined ? "fraction" : "unknown",
      quality: occupancy.fraction !== undefined ? "fraction" : "unknown",
    };
  }
  if (occupancy?.source === "native" || occupancy?.source === "derived") {
    const limit = occupancy.limitTokens ?? contextTokens;
    const used = occupancy.usedTokens;
    if (limit && used !== undefined) {
      const percent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
      return { known: true, inputTokens: used, contextTokens: limit, percent, level: percent < 70 ? "green" : percent < 90 ? "yellow" : "red", quality: occupancy.source };
    }
    if (occupancy.fraction !== undefined) {
      const percent = Math.min(100, Math.max(0, Math.round(occupancy.fraction * 100)));
      return { known: false, inputTokens: used ?? 0, contextTokens: limit ?? null, percent, level: "fraction", quality: occupancy.source, ...(used === undefined ? { hasTokenCount: false as const } : {}) };
    }
    return {
      known: false,
      inputTokens: used ?? 0,
      contextTokens: limit ?? null,
      percent: null,
      level: "unknown",
      quality: occupancy.source,
      ...(used === undefined ? { hasTokenCount: false as const } : {}),
    };
  }
  if (occupancy?.source === "estimated" && occupancy.usedTokens !== undefined && (occupancy.limitTokens ?? contextTokens)) {
    const limit = occupancy.limitTokens ?? contextTokens!;
    const percent = Math.min(100, Math.max(0, Math.round((occupancy.usedTokens / limit) * 100)));
    return { known: true, inputTokens: occupancy.usedTokens, contextTokens: limit, percent, level: percent < 70 ? "green" : percent < 90 ? "yellow" : "red", quality: "estimated" };
  }
  if (occupancy && (occupancy.usedTokens === undefined || !occupancy.limitTokens)) {
    const inputTokens = occupancy.usedTokens ?? contextTokensUsed(model);
    const limit = occupancy.limitTokens ?? contextTokens;
    if (limit && limit > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((inputTokens / limit) * 100)));
      return { known: true, inputTokens, contextTokens: limit, percent, level: percent < 70 ? "green" : percent < 90 ? "yellow" : "red", quality: "estimated" };
    }
    return {
      known: false,
      inputTokens,
      contextTokens: limit && limit > 0 ? limit : null,
      percent: null,
      level: "unknown",
      quality: inputTokens > 0 || model.contextUsage || occupancy.source === "estimated" ? "estimated" : "unknown",
    };
  }
  const inputTokens = contextTokensUsed(model);
  if (model.contextEstimateAfterSeq !== undefined && !model.contextUsage && inputTokens === 0) {
    return { known: false, inputTokens: 0, contextTokens: contextTokens ?? null, percent: null, level: "unknown", quality: "unknown", hasTokenCount: false };
  }
  if (!Number.isFinite(contextTokens) || !contextTokens || contextTokens <= 0) {
    return {
      known: false,
      inputTokens,
      contextTokens: null,
      percent: null,
      level: "unknown",
      quality: inputTokens > 0 || model.contextUsage ? "estimated" : "unknown",
    };
  }
  const percent = Math.min(100, Math.max(0, Math.round((inputTokens / contextTokens) * 100)));
  return {
    known: true,
    inputTokens,
    contextTokens,
    percent,
    level: percent < 70 ? "green" : percent < 90 ? "yellow" : "red",
    quality: "estimated",
  };
}

export type ContextTelemetryStatus =
  | NonNullable<RuntimeFeaturesDto["telemetry"]>["context"]["status"]
  | "unknown";

/** Older servers may omit telemetry; keep that distinct from an explicit
 * unsupported/unavailable response while preserving their legacy gauge. */
export function contextTelemetryStatus(
  telemetry: RuntimeFeaturesDto["telemetry"] | undefined,
): ContextTelemetryStatus {
  return telemetry?.context.status ?? "unknown";
}

/** A context sample can be useful even without a denominator. Native and
 * derived counts remain exact; the portable conversation estimate is clearly
 * marked as estimated by its quality. */
export function contextHasSample(gauge: ContextGauge): boolean {
  return gauge.known || (gauge.hasTokenCount !== false && (
    gauge.quality === "native"
    || gauge.quality === "derived"
    || gauge.quality === "estimated"));
}

/** Use live occupancy when present, then fall back to the selected model's
 * context limit. Runtime capability status explains a missing sample; it never
 * erases a partial native/derived count or a portable conversation estimate. */
export function contextGaugeForTelemetry(
  model: Parameters<typeof contextGauge>[0],
  contextTokens: Parameters<typeof contextGauge>[1],
  occupancy: Parameters<typeof contextGauge>[2],
  telemetryStatus: ContextTelemetryStatus,
  identity?: ContextIdentity,
): ContextGauge {
  void telemetryStatus;
  return contextGauge(model, contextTokens, occupancy, identity);
}

export function contextTelemetryNotice(
  telemetryStatus: ContextTelemetryStatus,
  gauge: ContextGauge,
): string | undefined {
  if (contextHasSample(gauge) || gauge.percent !== null) return undefined;
  if (gauge.contextTokens !== null) return tr("context.usageUnavailable");
  if (telemetryStatus === "unsupported") return tr("composer.contextWindowUnsupported");
  if (telemetryStatus === "unavailable") return tr("composer.contextWindowUnavailable");
  return tr("railsurfaces.modelContextMetadataIsUnavailable");
}

/** Warning tone for any measurable share, including a window known only as a
 *  fraction: amber from 70%, red from 90%. */
export function contextTone(gauge: ContextGauge): "green" | "yellow" | "red" | "unknown" {
  if (gauge.known) return gauge.level;
  if (gauge.level !== "fraction" || gauge.percent === null) return "unknown";
  return gauge.percent < 70 ? "green" : gauge.percent < 90 ? "yellow" : "red";
}

/** Percent label for context UI: estimated values carry a ~ prefix. */
export function formatContextPercent(gauge: ContextGauge): string | null {
  if (gauge.percent === null) return null;
  if (!gauge.known && gauge.level !== "fraction") return null;
  const prefix = gauge.quality === "estimated" ? "~" : "";
  return `${prefix}${gauge.percent}%`;
}

function str(d: JsonObject, k: string): string | undefined {
  const v = d[k];
  return typeof v === "string" ? v : undefined;
}
function num(d: JsonObject, k: string): number | undefined {
  const v = d[k];
  return typeof v === "number" ? v : undefined;
}
function obj(d: JsonObject, k: string): JsonObject | undefined {
  const v = d[k];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : undefined;
}
function strArr(d: JsonObject, k: string): string[] {
  const v = d[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// Lookup indexes (partId → assistant, callId → tool) so streaming reduction is
// O(1) per event instead of a linear scan over all messages. Kept in a WeakMap
// keyed by model so reduceEvent's signature and buildModel's replay purity are
// unchanged: the index is built lazily from messages and maintained on push.
interface MessageIndex {
  assistants: Map<string, AssistantMsg>;
  tools: Map<string, ToolMsg>;
  positions: WeakMap<RenderMessage, number>;
}

const messageIndexes = new WeakMap<RenderModel, MessageIndex>();

function messageIndex(m: RenderModel): MessageIndex {
  let idx = messageIndexes.get(m);
  if (!idx) {
    idx = { assistants: new Map(), tools: new Map(), positions: new WeakMap() };
    // First occurrence wins, matching the previous `messages.find(...)` scans.
    for (const [position, msg] of m.messages.entries()) {
      idx.positions.set(msg, position);
      if (msg.kind === "assistant") {
        if (!idx.assistants.has(msg.partId)) idx.assistants.set(msg.partId, msg);
      } else if (msg.kind === "tool") {
        if (!idx.tools.has(msg.callId)) idx.tools.set(msg.callId, msg);
      }
    }
    messageIndexes.set(m, idx);
  }
  return idx;
}

function findAssistant(m: RenderModel, partId: string): AssistantMsg | undefined {
  return messageIndex(m).assistants.get(partId);
}
function findTool(m: RenderModel, callId: string): ToolMsg | undefined {
  return messageIndex(m).tools.get(callId);
}
function pushAssistant(m: RenderModel, msg: AssistantMsg): void {
  m.messages.push(msg);
  const idx = messageIndex(m);
  idx.positions.set(msg, m.messages.length - 1);
  if (!idx.assistants.has(msg.partId)) idx.assistants.set(msg.partId, msg);
}
/** Claude (and similar) can stream a row under one partId and then finalize
 *  the same answer under another. Adopt the live row so replay does not keep
 *  an unfinalized copy plus a second caret-less bubble. */
function findUnfinalizedAssistantPrefix(model: RenderModel, text: string | undefined): AssistantMsg | undefined {
  if (text === undefined) return undefined;
  for (let i = model.messages.length - 1; i >= 0; i--) {
    const msg = model.messages[i];
    if (!msg || msg.kind !== "assistant") continue;
    if (msg.finalized) return undefined;
    return text.startsWith(msg.text) ? msg : undefined;
  }
  return undefined;
}
function adoptAssistantPart(model: RenderModel, msg: AssistantMsg, partId: string): void {
  const idx = messageIndex(model);
  if (msg.partId !== partId) {
    idx.assistants.delete(msg.partId);
    msg.partId = partId;
  }
  if (!idx.assistants.has(partId)) idx.assistants.set(partId, msg);
}
function pushTool(m: RenderModel, msg: ToolMsg): void {
  m.messages.push(msg);
  const idx = messageIndex(m);
  idx.positions.set(msg, m.messages.length - 1);
  if (!idx.tools.has(msg.callId)) idx.tools.set(msg.callId, msg);
}

/** A rate-limited request produces no answer, so a turn that stops with a
 *  resume plan and ends on a bare one-line text ends on the provider's limit
 *  line (logs from before the Claude backend withheld it still carry one). */
function markProviderNotice(model: RenderModel, startedAt: number | undefined): void {
  const last = model.messages.at(-1);
  if (startedAt === undefined || last?.kind !== "assistant" || !last.finalized || last.time < startedAt) return;
  const text = last.text.trim();
  if (!text || text.includes("\n") || text.length > 240 || last.reasoning.trim() || last.tokens) return;
  last.providerNotice = true;
  touch(last);
}

/** In-place message mutation marker (see UserMsg.rev). */
function touch(m: RenderMessage): void {
  m.rev = (m.rev ?? 0) + 1;
}

/** Display-only settle for tools still open when a turn ends. The event log
 *  correctly leaves incomplete tools incomplete (no invented completion);
 *  the UI model must not keep spinners forever. Reasons stay short and do
 *  not invent tool output. */
function orphanToolReason(status: TurnState["status"]): string {
  if (status === "aborted") return "Interrupted";
  if (status === "failed") return "Turn ended before tool completed";
  return "Stopped";
}

function finalizeOrphanedTools(model: RenderModel, status: TurnState["status"], stopTime: number): void {
  const reason = orphanToolReason(status);
  for (const message of model.messages) {
    if (message.kind !== "tool") continue;
    if (message.status !== "pending" && message.status !== "running") continue;
    message.status = "error";
    message.error = reason;
    message.finishTime = stopTime;
    touch(message);
  }
}

/** Forget rows a keep-alive turn produced, including their index entries. */
function dropKeepAliveRows(model: RenderModel, from: number): void {
  const idx = messageIndex(model);
  for (const msg of model.messages.splice(from)) {
    if (msg.kind === "assistant" && idx.assistants.get(msg.partId) === msg) idx.assistants.delete(msg.partId);
    else if (msg.kind === "tool" && idx.tools.get(msg.callId) === msg) idx.tools.delete(msg.callId);
  }
}

export function reduceEvent(model: RenderModel, ev: SessionEvent): RenderModel {
  const d = ev.data;
  const messageCountBefore = model.messages.length;
  if (ev.type === "user/message" && d.keepAlive === true) {
    model.keepAliveTurn = true;
    model.version += 1;
    return model;
  }
  if (model.keepAliveTurn) {
    // A person's message (a steer) ends the maintenance view; the keep-alive's
    // own boundaries and admission records never replace the visible turn.
    if (ev.type === "user/message") delete model.keepAliveTurn;
    else if (ev.type === "turn/started" || ev.type === "turn/stopped" || ev.type.startsWith("mutation/")) {
      if (ev.type === "turn/stopped") delete model.keepAliveTurn;
      model.version += 1;
      return model;
    }
  }
  // Queue events carry no message payload (the durable queue is REST-read);
  // this counter is the refetch signal. They still reach package reducers.
  if (ev.type.startsWith("queue/") || ev.type === "delivery/fallback-queued") {
    model.queueVersion += 1;
  }
  switch (ev.type) {
    case "isolation/merged": {
      const branch = str(d, "targetBranch") ?? "";
      const commit = (str(d, "commit") ?? "").slice(0, 7);
      model.messages.push({
        kind: "notice",
        id: ev.id,
        eventSeq: ev.seq,
        topic: "isolation-merged",
        ...(branch ? { branch } : {}),
        ...(commit ? { commit } : {}),
        time: ev.time,
      });
      break;
    }
    case "isolation/discarded": {
      model.messages.push({
        kind: "notice",
        id: ev.id,
        eventSeq: ev.seq,
        topic: "isolation-discarded",
        ...(str(d, "targetBranch") ? { branch: str(d, "targetBranch") } : {}),
        ...(d.returned === true ? { returned: true } : {}),
        time: ev.time,
      });
      break;
    }
    case "isolation/started": {
      const uncommitted = num(d, "originUncommitted");
      model.messages.push({
        kind: "notice",
        id: ev.id,
        eventSeq: ev.seq,
        topic: "isolation-started",
        ...(str(d, "targetBranch") ? { branch: str(d, "targetBranch") } : {}),
        ...(uncommitted !== undefined && Number.isSafeInteger(uncommitted) && uncommitted > 0 ? { uncommitted } : {}),
        time: ev.time,
      });
      break;
    }
    case "github/conflict-resolution-started": {
      const prNumber = num(d, "prNumber");
      if (prNumber === undefined || !Number.isSafeInteger(prNumber) || prNumber <= 0) break;
      model.messages.push({
        kind: "github-conflict",
        id: ev.id,
        eventSeq: ev.seq,
        prNumber,
        title: str(d, "title") ?? "",
        url: str(d, "url") ?? "",
        baseRefName: str(d, "baseRefName") ?? "",
        headRefName: str(d, "headRefName") ?? "",
        time: ev.time,
      });
      break;
    }
    case "mutation/uncertainty-recorded":
    case "mutation/fenced": {
      if (str(d, "mutationKind") !== "turn-submit" || model.lastUserMessageHidden) break;
      for (let i = model.messages.length - 1; i >= 0; i -= 1) {
        const msg = model.messages[i];
        if (msg?.kind === "user" && !msg.uncertain) {
          msg.uncertain = true;
          touch(msg);
          break;
        }
      }
      break;
    }
    case "user/message": {
      // Every prompt carries the people messages queued for the agent.
      for (let index = model.messages.length - 1; index >= 0; index -= 1) {
        const earlier = model.messages[index]!;
        if (earlier.kind !== "person-message" || !earlier.carryToAgent) continue;
        if (earlier.delivered) break;
        earlier.delivered = true;
        touch(earlier);
      }
      const text = stripRecoveryContextBlocks(str(d, "text") ?? "");
      const rawValue = str(d, "raw");
      const raw = rawValue === undefined ? undefined : stripRecoveryContextBlocks(rawValue);
      const hiddenUserMessage = d.githubConflictResolution === true
        || d.hiddenUserMessage === true
        || d.autoResume === true;
      model.lastUserMessageHidden = hiddenUserMessage;
      const pressure = Number((d as { contextPressure?: { level?: unknown } }).contextPressure?.level);
      if (Number.isFinite(pressure)) model.contextPressureLevel = pressure;
      if (!hiddenUserMessage) {
        const msg: UserMsg = { kind: "user", id: ev.id, eventSeq: ev.seq, text, time: ev.time };
        if (raw !== undefined && raw !== text) msg.raw = raw;
        const author = normalizeSessionPerson((d as { author?: unknown }).author);
        if (author) msg.author = author;
        // Attachment pills on the message: keep only well-formed refs.
        const atts = (d as { attachments?: unknown }).attachments;
        if (Array.isArray(atts)) {
          const refs = atts.filter((a): a is AttachmentRef =>
            typeof a === "object" && a !== null
            && typeof (a as { name?: unknown }).name === "string"
            && typeof (a as { mime?: unknown }).mime === "string");
          if (refs.length > 0) msg.attachments = refs;
        }
        model.messages.push(msg);
      }
      model.changedFiles = [];
      // A child-origin prompt after the fork marker proves the seed was sent
      // (or replaced) — reload must not re-seed the composer.
      if (model.fork && !model.fork.seedConsumed && ev.seq > model.fork.markerSeq) {
        model.fork.seedConsumed = true;
      }
      break;
    }
    case "person/message": {
      const text = str(d, "text");
      if (typeof text !== "string") break;
      const author = normalizeSessionPerson((d as { author?: unknown }).author);
      const mentionsValue = (d as { mentions?: unknown }).mentions;
      const mentions = Array.isArray(mentionsValue)
        ? mentionsValue.flatMap((value) => {
          const person = normalizeSessionPerson(value);
          return person ? [person] : [];
        })
        : [];
      const msg: PersonMessageMsg = {
        kind: "person-message",
        id: ev.id,
        eventSeq: ev.seq,
        text,
        mentions,
        time: ev.time,
      };
      if (author) msg.author = author;
      if (d.carryToAgent === true) msg.carryToAgent = true;
      const replyToSeq = num(d, "replyToSeq");
      if (replyToSeq !== undefined) msg.replyToSeq = replyToSeq;
      const previous = model.messages[model.messages.length - 1];
      // Dividers mark time between people's messages only; a person message
      // after agent work reads in that work's flow.
      if (!previous || ((previous.kind === "person-message" || previous.kind === "conversation-started")
        && (ev.time - previous.time >= PERSON_MESSAGE_BREAK_MS || !sameLocalDay(previous.time, ev.time)))) {
        msg.timeBreak = true;
      }
      if (!msg.timeBreak && previous?.kind === "person-message" && author && previous.author?.userId === author.userId
        && ev.time - previous.time >= 0 && ev.time - previous.time < PERSON_MESSAGE_GROUP_MS) {
        msg.continuation = true;
        previous.continued = true;
        touch(previous);
      }
      model.messages.push(msg);
      break;
    }
    case "conversation/session-started": {
      const sessionId = str(d, "sessionId");
      if (!sessionId) break;
      const startedBy = normalizeSessionPerson((d as { startedBy?: unknown }).startedBy);
      const sourceValue = (d as { sourceSeqs?: unknown }).sourceSeqs;
      const sourceSeqs = Array.isArray(sourceValue)
        ? sourceValue.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
        : [];
      model.messages.push({
        kind: "conversation-started",
        id: ev.id,
        eventSeq: ev.seq,
        sessionId,
        title: str(d, "title") ?? "",
        sourceSeqs,
        ...(startedBy ? { startedBy } : {}),
        time: ev.time,
      });
      break;
    }
    case "assistant/chunk":
    case "assistant/reasoning-chunk": {
      const partId = str(d, "partId") ?? "";
      let m = findAssistant(model, partId);
      if (!m) {
        m = {
          kind: "assistant",
          id: partId,
          partId,
          eventSeq: ev.seq,
          text: "",
          reasoning: "",
          finalized: false,
          time: ev.time,
          ...(model.turn?.model ? { model: model.turn.model } : {}),
          ...(model.turn?.agent ? { agent: model.turn.agent } : {}),
          ...(model.turn?.harnessId ? { harnessId: model.turn.harnessId } : {}),
          ...(model.turn?.runtimeLegId ? { runtimeLegId: model.turn.runtimeLegId } : {}),
          ...(model.turn?.profileId ? { profileId: model.turn.profileId } : {}),
        };
        pushAssistant(model, m);
      }
      const text = str(d, "text") ?? "";
      if (ev.type === "assistant/chunk") {
        m.text += text;
      } else {
        m.reasoning += text;
        if (m.reasoningStartedAt === undefined) m.reasoningStartedAt = ev.time;
        m.reasoningEndedAt = ev.time;
      }
      touch(m);
      break;
    }
    case "assistant/message": {
      const partId = str(d, "partId") ?? "";
      const text = str(d, "text");
      let m = findAssistant(model, partId);
      if (!m) {
        m = findUnfinalizedAssistantPrefix(model, text);
        if (m) adoptAssistantPart(model, m, partId);
      }
      if (!m) {
        m = {
          kind: "assistant",
          id: partId,
          partId,
          eventSeq: ev.seq,
          text: "",
          reasoning: "",
          finalized: false,
          time: ev.time,
          ...(model.turn?.model ? { model: model.turn.model } : {}),
          ...(model.turn?.agent ? { agent: model.turn.agent } : {}),
          ...(model.turn?.harnessId ? { harnessId: model.turn.harnessId } : {}),
          ...(model.turn?.runtimeLegId ? { runtimeLegId: model.turn.runtimeLegId } : {}),
          ...(model.turn?.profileId ? { profileId: model.turn.profileId } : {}),
        };
        pushAssistant(model, m);
      }
      if (!m.model && model.turn?.model) m.model = model.turn.model;
      if (!m.agent && model.turn?.agent) m.agent = model.turn.agent;
      if (!m.harnessId && model.turn?.harnessId) m.harnessId = model.turn.harnessId;
      if (!m.runtimeLegId && model.turn?.runtimeLegId) m.runtimeLegId = model.turn.runtimeLegId;
      if (!m.profileId && model.turn?.profileId) m.profileId = model.turn.profileId;
      // Chunks make an answer visible before its canonical message row exists.
      // Actions such as pinning must nevertheless target that final row: the
      // server deliberately rejects transient `assistant/chunk` events.
      m.eventSeq = ev.seq;
      m.finalized = true;
      m.completedAt = ev.time; // semantic completion time, not first chunk
      if (text !== undefined) m.text = text;
      const reasoning = str(d, "reasoning");
      if (reasoning !== undefined) m.reasoning = reasoning;
      const tokens = obj(d, "tokens") as TokenUsage | undefined;
      if (tokens !== undefined) m.tokens = tokens;
      const cost = num(d, "cost");
      if (cost !== undefined) m.cost = cost;
      touch(m);
      break;
    }
    case "tool/call": {
      const callId = str(d, "callId") ?? "";
      const lifecycleStatus = str(d, "status");
      const status = lifecycleStatus === "pending" ? "pending" : "running";
      const existing = lifecycleStatus ? findTool(model, callId) : undefined;
      if (existing) {
        if (existing.status === "pending" && status === "running") {
          existing.status = "running";
          existing.time = ev.time;
        }
        const input = obj(d, "input");
        if (input && Object.keys(input).length > 0) existing.input = input;
        touch(existing);
      } else {
        pushTool(model, {
          kind: "tool",
          id: callId,
          callId,
          eventSeq: ev.seq,
          tool: str(d, "tool") ?? "",
          input: obj(d, "input") ?? {},
          status,
          time: ev.time,
          ...(ev.producerPlugin === "composer-shell" ? { composerShell: true } : {}),
        });
      }
      break;
    }
    case "tool/started": {
      const callId = str(d, "callId") ?? "";
      const existing = findTool(model, callId);
      if (existing) {
        if (existing.status === "pending") {
          existing.status = "running";
          existing.time = ev.time;
        }
        const input = obj(d, "input");
        if (input && Object.keys(input).length > 0) existing.input = input;
        touch(existing);
      } else {
        pushTool(model, {
          kind: "tool",
          id: callId,
          callId,
          eventSeq: ev.seq,
          tool: str(d, "tool") ?? "",
          input: obj(d, "input") ?? {},
          status: "running",
          time: ev.time,
        });
      }
      break;
    }
    case "tool/result": {
      const t = findTool(model, str(d, "callId") ?? "");
      if (t) {
        // Late results after turn/stopped interrupt still win — clear any
        // display-only orphan reason so the real output is what the UI shows.
        t.status = "done";
        t.output = str(d, "output") ?? "";
        delete t.error;
        const title = str(d, "title");
        if (title !== undefined) t.title = title;
        const metadata = obj(d, "metadata");
        if (metadata !== undefined) t.metadata = metadata;
        const lateInput = obj(d, "input");
        if (lateInput && Object.keys(lateInput).length > 0) {
          t.input = { ...t.input, ...lateInput };
        }
        const changedFiles = extractChangedFiles(t.tool, lateInput ?? t.input, obj(d, "metadata"));
        if (changedFiles.length > 0) {
          t.changedFiles = changedFiles;
          model.changedFiles = [...new Set([...model.changedFiles, ...changedFiles])];
        }
        t.finishTime = ev.time;
        touch(t);
      }
      break;
    }
    case "tool/error": {
      const callId = str(d, "callId") ?? "";
      const t = findTool(model, callId);
      if (t) {
        t.status = "error";
        t.error = str(d, "error") ?? "";
        t.finishTime = ev.time;
        touch(t);
      } else {
        pushTool(model, {
          kind: "tool",
          id: callId,
          callId,
          eventSeq: ev.seq,
          tool: str(d, "tool") ?? "",
          input: {},
          status: "error",
          error: str(d, "error") ?? "",
          time: ev.time,
          finishTime: ev.time,
        });
      }
      break;
    }
    case "session/rewound": {
      const atSeq = num(d, "atSeq");
      if (atSeq === undefined || !Number.isSafeInteger(atSeq) || atSeq <= 0) break;
      // Replay-derived composer seed: the target user/message already owns the
      // raw text and attachments — new markers never duplicate them (spec).
      const target = model.messages.find(
        (message): message is UserMsg => message.kind === "user" && message.eventSeq === atSeq,
      );
      // A rewound answer keeps its question in the conversation; only the
      // reply leaves, and returns to the composer as the editable draft.
      const answered = target ? undefined : model.messages.find(
        (message): message is QuestionMsg => message.kind === "question" && message.answeredSeq === atSeq,
      );
      for (const message of model.messages) {
        if (!message.undone && message.eventSeq >= atSeq) {
          message.undone = true;
          message.rewindMarkerSeq = ev.seq;
          touch(message);
        } else if (message.kind === "question" && !message.undone && message.answeredSeq !== undefined
          && message.answeredSeq >= atSeq && message.answerRewindMarkerSeq === undefined) {
          message.answerRewindMarkerSeq = ev.seq;
          touch(message);
        }
      }
      const restoredText = str(d, "restoredText"); // legacy markers only
      const draft: SeedDraft | undefined = target
        ? {
            text: target.raw ?? target.text,
            ...(target.attachments && target.attachments.length > 0
              ? { attachments: target.attachments }
              : {}),
          }
        : answered?.answers
          ? { text: questionAnswerDraft(normalizeQuestions(answered.questions), answered.answers as AnswerMap) }
          : restoredText !== undefined
            ? { text: restoredText }
            : undefined;
      model.rewind = {
        markerSeq: ev.seq,
        atSeq,
        ...(restoredText !== undefined ? { restoredText } : {}),
        ...(draft ? { draft } : {}),
      };
      break;
    }
    case "session/rewind-cleared": {
      const rewindSeq = num(d, "rewindSeq");
      if (!model.rewind || (rewindSeq !== undefined && rewindSeq !== model.rewind.markerSeq)) break;
      if (d.replaced !== true) {
        for (const message of model.messages) {
          if (message.rewindMarkerSeq === model.rewind.markerSeq) {
            delete message.undone;
            delete message.rewindMarkerSeq;
            touch(message);
          } else if (message.kind === "question" && message.answerRewindMarkerSeq === model.rewind.markerSeq) {
            delete message.answerRewindMarkerSeq;
            touch(message);
          }
        }
      } else {
        for (const message of model.messages) {
          if (message.kind === "question" && message.answerRewindMarkerSeq === model.rewind.markerSeq) {
            message.answerReplaced = true;
            touch(message);
          }
        }
      }
      model.rewind = null;
      break;
    }
    case "session/forked": {
      // Ignorable lineage marker on the CHILD log (per-message forks carry the
      // excluded prompt as an editable, never model-visible, draft).
      const fromSessionId = str(d, "fromSessionId");
      if (fromSessionId === undefined) break;
      const rawDraft = obj(d, "draft");
      let draft: SeedDraft | undefined;
      if (rawDraft && typeof rawDraft.text === "string") {
        const atts = (rawDraft as { attachments?: unknown }).attachments;
        draft = {
          text: rawDraft.text,
          ...(Array.isArray(atts) && atts.length > 0 ? { attachments: atts as AttachmentRef[] } : {}),
        };
      }
      const sourceAtSeq = num(d, "sourceAtSeq");
      model.fork = {
        fromSessionId,
        markerSeq: ev.seq,
        ...(sourceAtSeq !== undefined ? { sourceAtSeq } : {}),
        ...(draft ? { draft } : {}),
        seedConsumed: false,
      };
      break;
    }
    case "task/snapshot": {
      const revision = num(d, "revision") ?? 0;
      // Snapshots are full state: apply only monotonically increasing revisions
      // so out-of-order delivery can never regress the projection.
      if (model.tasks && revision <= model.tasks.revision) break;
      const items = Array.isArray(d.items) ? (d.items as TaskListState["items"]) : [];
      const listId = str(d, "listId") ?? "todo";
      const previous = new Map(model.tasks?.items.map((item) => [item.id, item]));
      for (const item of items) {
        const old = previous.get(item.id);
        let action: TaskActivityMsg["action"] | null = null;
        if (!old || old.status !== item.status) {
          if (item.status === "active") action = "started";
          else if (item.status === "done") action = "completed";
          else if (item.status === "failed") action = "failed";
          else if (!old) action = "created";
        }
        if (action) {
          model.messages.push({
            kind: "task",
            id: `task-${listId}-${revision}-${item.id}-${action}`,
            eventSeq: ev.seq,
            taskId: item.id,
            text: item.text,
            action,
            time: ev.time,
          });
        }
      }
      model.tasks = { listId, revision, items };
      break;
    }
    case "subagent/snapshot": {
      const revision = num(d, "revision") ?? 0;
      if (model.subagents && revision <= model.subagents.revision) break;
      const agents = Array.isArray(d.agents) ? (d.agents as SubagentState["agents"]) : [];
      model.subagents = { revision, agents };
      break;
    }
    case "permission/requested": {
      const requestId = str(d, "requestId") ?? "";
      if (!model.permissions.some((p) => p.requestId === requestId)) {
        const rawPreview = obj(d, "preview") as { title?: unknown; lines?: unknown; risk?: unknown; reasons?: unknown; scopeCheck?: unknown } | undefined;
        const riskRaw = rawPreview?.risk;
        const risk: "low" | "medium" | "high" | undefined =
          riskRaw === "low" || riskRaw === "medium" || riskRaw === "high" ? riskRaw : undefined;
        const reasons = Array.isArray(rawPreview?.reasons)
          ? rawPreview.reasons.filter((reason): reason is string => typeof reason === "string")
          : [];
        // The held request's chance travels with the preview, so the card can
        // say "Outside the task · 86%" rather than only the reason.
        const scopeProbability = (rawPreview?.scopeCheck as { probability?: unknown } | undefined)?.probability;
        const scopeCheck = typeof scopeProbability === "number" && Number.isFinite(scopeProbability)
          && scopeProbability >= 0 && scopeProbability <= 1 ? { probability: scopeProbability } : undefined;
        const preview = rawPreview && typeof rawPreview.title === "string" && Array.isArray(rawPreview.lines)
          ? {
              title: rawPreview.title,
              lines: rawPreview.lines.filter((l): l is string => typeof l === "string"),
              ...(risk ? { risk } : {}),
              ...(reasons.length ? { reasons } : {}),
              ...(scopeCheck ? { scopeCheck } : {}),
            }
          : undefined;
        const scopes = strArr(d, "allowedScopes").filter(
          (s): s is "once" | "session" | "project" => s === "once" || s === "session" || s === "project",
        );
        model.permissions.push({
          sessionId: ev.sessionId,
          requestId,
          permission: str(d, "permission") ?? "",
          patterns: strArr(d, "patterns"),
          tool: str(d, "tool"),
          status: "pending",
          time: ev.time,
          ...(ev.producerPlugin === "composer-shell" ? { manual: true } : {}),
          ...(preview ? { preview } : {}),
          ...(scopes.length > 0 ? { allowedScopes: scopes } : {}),
          ...(str(d, "sourceSessionId") ? { sourceSessionId: str(d, "sourceSessionId") } : {}),
        });
      }
      break;
    }
    case "permission/delegated": {
      const p = model.permissions.find((x) => x.requestId === str(d, "requestId"));
      if (p) p.delegated = true;
      break;
    }
    case "permission/resolved": {
      const requestId = str(d, "requestId") ?? "";
      const p = model.permissions.find((x) => x.requestId === requestId);
      if (p) {
        p.status = "resolved";
        const reply = str(d, "reply");
        if (reply === "once" || reply === "always" || reply === "reject") p.reply = reply;
        if (d.auto === true) p.auto = true; // policy-approved, no human click
      }
      break;
    }
    case "question/asked": {
      const requestId = str(d, "requestId") ?? "";
      if (!model.questions.some((q) => q.requestId === requestId)) {
        const questions = Array.isArray(d.questions) ? (d.questions as JsonObject[]) : [];
        model.questions.push({
          sessionId: ev.sessionId,
          requestId,
          questions,
          status: "pending",
          time: ev.time,
        });
        const sourceSessionId = str(d, "sourceSessionId");
        model.messages.push({
          kind: "question",
          id: `question-${requestId || ev.id}`,
          eventSeq: ev.seq,
          requestId,
          questions,
          status: "pending",
          ...(sourceSessionId && sourceSessionId !== ev.sessionId ? { sourceSessionId } : {}),
          time: ev.time,
        });
      }
      break;
    }
    case "question/answered":
    case "question/expired": {
      const requestId = str(d, "requestId") ?? "";
      const status = ev.type === "question/expired" || d.rejected === true ? "rejected" : "answered";
      const answers = obj(d, "answers");
      const q = model.questions.find((x) => x.requestId === requestId);
      if (q) {
        q.status = status;
        if (answers !== undefined) q.answers = answers;
      }
      const record = model.messages.find((message): message is QuestionMsg =>
        message.kind === "question" && message.requestId === requestId && message.status === "pending");
      if (record) {
        record.status = status;
        if (answers !== undefined) record.answers = answers;
        if (status === "answered") {
          record.answeredSeq = ev.seq;
          record.answeredAt = ev.time;
        }
        touch(record);
      }
      break;
    }
    case "secret/requested": {
      const requestId = str(d, "requestId") ?? "";
      if (!model.secrets.some((secret) => secret.requestId === requestId)) {
        model.secrets.push({
          sessionId: ev.sessionId,
          requestId,
          handle: str(d, "handle") ?? "",
          label: str(d, "label") ?? "",
          purpose: str(d, "purpose"),
          kind: str(d, "kind"),
          ...(d.existing === true ? { existing: true } : {}),
          status: "pending",
          time: ev.time,
        });
      }
      break;
    }
    case "secret/resolved": {
      const requestId = str(d, "requestId") ?? "";
      const secret = model.secrets.find((item) => item.requestId === requestId);
      if (secret) {
        secret.status = "resolved";
        const action = str(d, tr("reduce.action"));
        if (action === "saved" || action === "dismissed") secret.action = action;
      }
      break;
    }
    case "session/compacted":
    case "runtime/epoch-replaced": {
      model.contextUsage = null;
      model.contextEstimateAfterSeq = ev.seq;
      model.contextResetAt = ev.time;
      delete model.contextPressureLevel;
      break;
    }
    case "turn/started": {
      const turnModel = obj(d, "model") as ModelRef | undefined;
      const previousModel = model.contextUsage?.model ?? model.turn?.model;
      const harnessId = str(d, "harnessId");
      const previousHarness = model.contextUsage?.harnessId ?? model.turn?.harnessId;
      if ((turnModel && previousModel && !sameContextModel(turnModel, previousModel))
        || (harnessId && previousHarness && harnessId !== previousHarness)) {
        model.contextUsage = null;
        model.contextResetAt = ev.time;
      }
      model.turn = {
        turnId: str(d, "turnId") ?? "",
        status: "working",
        model: turnModel,
        agent: str(d, "agent"),
        harnessId: str(d, "harnessId"),
        runtimeLegId: str(d, "runtimeLegId"),
        profileId: str(d, "profileId"),
        startedAt: ev.time,
      };
      // Same-model samples remain useful. Never manufacture a zero sample or
      // relabel another model's footprint during a switch.
      break;
    }
    case "turn/stopped": {
      const reason = str(d, "reason");
      const status: TurnState["status"] =
        reason === "aborted" ? "aborted" : reason === "error" ? "failed" : "stopped";
      // A provider rate-limit / quota / overload stop carries a resume plan;
      // the timeline shows a countdown with cancel / switch-model instead of
      // the generic failure line.
      const retry = obj(d, "retry");
      const limit: TurnLimitState | undefined =
        retry && typeof retry.resumeAt === "number"
          ? {
              scope: (typeof retry.scope === "string" ? retry.scope : "unknown") as RateLimitScope,
              ...(typeof retry.provider === "string" ? { provider: retry.provider } : {}),
              ...(typeof retry.retryAfterSec === "number" ? { retryAfterSec: retry.retryAfterSec } : {}),
              ...(typeof retry.maxAttempts === "number" ? { maxAttempts: retry.maxAttempts } : {}),
              resumeAt: retry.resumeAt,
              attempt: typeof retry.attempt === "number" ? retry.attempt : 1,
            }
          // The provider refused the selected model or quota is exhausted:
          // no wait can clear it, so the same inline surface offers the model switch without a countdown.
          : str(d, "code") === "model-unavailable"
            ? { scope: "unknown" as RateLimitScope, attempt: 1, code: "model-unavailable" as const }
            : str(d, "code") === "quota-exhausted"
              ? { scope: "quota" as RateLimitScope, attempt: 1, code: "quota-exhausted" as const }
              : undefined;
      const t = model.turn;
      if (t) {
        t.status = status;
        t.reason = reason;
        t.stoppedAt = ev.time;
        const error = str(d, "error");
        if (error !== undefined) t.error = error;
        if (limit) {
          t.limit = limit;
          t.providerLimited = true;
        } else {
          delete t.limit;
          delete t.providerLimited;
        }
        if (retry) markProviderNotice(model, t.startedAt);
      } else {
        // Unmatched stop (copied/partial log): no startedAt, so no duration.
        model.turn = {
          turnId: str(d, "turnId") ?? "", status, reason, error: str(d, "error"), stoppedAt: ev.time,
          ...(limit ? { limit, providerLimited: true as const } : {}),
        };
      }
      finalizeOrphanedTools(model, status, ev.time);
      break;
    }
    case "turn/resume-cancelled": {
      // The wait ended (user cancelled, switched model, or the resend fired).
      if (model.turn) delete model.turn.limit;
      break;
    }
    case "usage/recorded": {
      const t = obj(d, "tokens") as TokenUsage | undefined;
      const cost = num(d, "cost");
      if (t) {
        model.totals.input += t.input ?? 0;
        model.totals.output += t.output ?? 0;
        model.totals.reasoning += t.reasoning ?? 0;
        model.totals.cacheRead += t.cacheRead ?? 0;
        model.totals.cacheWrite += t.cacheWrite ?? 0;
        const usageModel = (obj(d, "model") as ModelRef | undefined) ?? model.turn?.model;
        const usageHarness = str(d, "harnessId") ?? model.turn?.harnessId;
        // Overwrite (not accumulate): each request re-sends the whole
        // conversation, so the newest sample already reflects the full live
        // context. Summing would double-count history every turn. A sample
        // that sums several requests describes no single context at all.
        if (d.aggregate !== true) model.contextUsage = {
          inputTokens: Math.max(0, t.input ?? 0),
          cacheReadTokens: Math.max(0, t.cacheRead ?? 0),
          cacheWriteTokens: Math.max(0, t.cacheWrite ?? 0),
          ...(usageModel ? { model: usageModel } : model.contextUsage?.model ? { model: model.contextUsage.model } : {}),
          ...(usageHarness ? { harnessId: usageHarness } : {}),
        };
      }
      if (cost !== undefined) model.totals.cost += cost;
      // Per-turn usage, kept apart from lifetime totals: a forked child's
      // footer must reflect its own terminal turn, never inherited sums.
      if (model.turn && !model.keepAliveTurn && (t || cost !== undefined)) {
        const u = model.turn.usage ?? { tokens: { input: 0, output: 0 }, cost: 0 };
        if (t) {
          u.tokens = {
            input: (u.tokens.input ?? 0) + (t.input ?? 0),
            output: (u.tokens.output ?? 0) + (t.output ?? 0),
            reasoning: (u.tokens.reasoning ?? 0) + (t.reasoning ?? 0),
            cacheRead: (u.tokens.cacheRead ?? 0) + (t.cacheRead ?? 0),
            cacheWrite: (u.tokens.cacheWrite ?? 0) + (t.cacheWrite ?? 0),
          };
        }
        if (cost !== undefined) u.cost += cost;
        model.turn.usage = u;
      }
      break;
    }
    case "goal/attached": {
      model.goal = {
        objective: str(d, "objective") ?? "",
        status: "active",
        continuations: 0,
        maxContinuations: typeof d.maxContinuations === "number" ? d.maxContinuations : 12,
        tokensUsed: 0,
        budgetTokens: typeof d.budgetTokens === "number" ? d.budgetTokens : 0,
        stuckStreak: 0,
        updatedAt: ev.time,
      };
      break;
    }
    case "goal/audit": {
      if (model.goal) {
        const v = str(d, "verdict") as GoalVerdict | undefined;
        if (v) model.goal.lastVerdict = v;
        const note = str(d, "reason") ?? str(d, "note");
        if (note !== undefined) model.goal.lastReason = note;
        if (typeof d.continuations === "number") model.goal.continuations = d.continuations;
        if (typeof d.tokensUsed === "number") model.goal.tokensUsed = d.tokensUsed;
        if (Array.isArray(d.waitingFor)) model.goal.waitingFor = d.waitingFor.filter((id): id is string => typeof id === "string");
        if (typeof d.auditRevision === "string") model.goal.auditRevision = d.auditRevision;
        model.goal.updatedAt = ev.time;
      }
      break;
    }
    case "goal/stopped": {
      // Stop is a removal operation in the goal service. Clearing the client
      // projection keeps the durable event history while allowing a fresh
      // goal to be attached immediately.
      model.goal = null;
      break;
    }
    case "goal/completed":
    case "goal/stuck":
    case "goal/paused":
    case "goal/resumed": {
      if (model.goal) {
        const statusMap: Record<string, GoalState["status"]> = {
          "goal/completed": "completed",
          "goal/stuck": "stuck",
          "goal/paused": "paused",
          "goal/resumed": "active",
        };
        const s = statusMap[ev.type];
        if (s) model.goal.status = s;
        const reason = str(d, "lastReason");
        if (reason !== undefined) model.goal.lastReason = reason;
        model.goal.updatedAt = ev.time;
      }
      break;
    }
    case "multirun/started": {
      const runsRaw = Array.isArray(d.runs) ? d.runs : [];
      const runs: MultirunRunDto[] = runsRaw.map((raw) => {
        const r = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
        const modelRef = obj(r, "model") as ModelRef | undefined;
        return {
          id: str(r, "runId") ?? str(r, "id") ?? "",
          status: "pending",
          output: "",
          ...(modelRef ? { model: modelRef } : {}),
          ...(str(r, "agent") ? { agent: str(r, "agent") } : {}),
        };
      });
      model.multirun = {
        id: str(d, "multirunId") ?? "",
        prompt: str(d, "prompt") ?? "",
        runs,
      };
      break;
    }
    case "multirun/run-progress": {
      const mr = model.multirun;
      if (mr && mr.id === (str(d, "multirunId") ?? mr.id)) {
        const runId = str(d, "runId") ?? "";
        let run = mr.runs.find((x) => x.id === runId);
        if (!run) {
          run = { id: runId, status: "pending", output: "" };
          mr.runs.push(run);
        }
        const status = str(d, "status");
        if (status === "pending" || status === "running" || status === "completed" || status === "failed") {
          run.status = status;
        }
        const output = str(d, "output");
        if (output !== undefined) run.output = output;
        const tokens = obj(d, "tokens") as TokenUsage | undefined;
        if (tokens) run.tokens = tokens;
        const cost = num(d, "cost");
        if (cost !== undefined) run.cost = cost;
        const error = str(d, "error");
        if (error !== undefined) run.error = error;
        const startedAt = num(d, "startedAt");
        if (startedAt !== undefined) run.startedAt = startedAt;
        const finishedAt = num(d, "finishedAt");
        if (finishedAt !== undefined) run.finishedAt = finishedAt;
      }
      break;
    }
    case "multirun/completed": {
      // terminal marker — individual run statuses already applied
      break;
    }
    case "multirun/picked": {
      if (model.multirun && model.multirun.id === (str(d, "multirunId") ?? model.multirun.id)) {
        const runId = str(d, "runId");
        if (runId) model.multirun.pickedRunId = runId;
      }
      break;
    }
    case "workflow/run-started": {
      const nodes = Array.isArray(d.nodes)
        ? (d.nodes as unknown as WorkflowRunNodeDto[]).map((node) => ({ ...node }))
        : [];
      const layers = Array.isArray(d.layers)
        ? (d.layers as unknown[]).map((layer) =>
            Array.isArray(layer) ? layer.filter((id): id is string => typeof id === "string") : [])
        : [];
      model.workflowRun = {
        id: str(d, "runId") ?? "",
        workflowId: str(d, "workflowId") ?? "",
        ...(str(d, "projectId") ? { projectId: str(d, "projectId") } : {}),
        ...(str(d, "parentSessionId") ? { parentSessionId: str(d, "parentSessionId") } : {}),
        name: str(d, "name") ?? "",
        input: str(d, "input") ?? "",
        ...(str(d, "clientOperationId") ? { clientOperationId: str(d, "clientOperationId") } : {}),
        ...(str(d, "retryOf") ? { retryOf: str(d, "retryOf") } : {}),
        ...(obj(d, "context") ? { context: obj(d, "context") as unknown as import("@polyth/contracts").WorkflowRunContextDto } : {}),
        ...(obj(d, "definition") ? { definition: obj(d, "definition") as unknown as import("@polyth/contracts").WorkflowDto } : {}),
        ...(obj(d, "options")
          ? { options: obj(d, "options") as unknown as Required<WorkflowRunOptionsDto> }
          : {}),
        status: "running",
        startedAt: num(d, "startedAt") ?? ev.time,
        layers,
        nodes,
      };
      model.workflowRunSeq = ev.seq;
      break;
    }
    case "workflow/node-progress": {
      const run = model.workflowRun;
      if (!run || run.id !== (str(d, "runId") ?? run.id)) break;
      const raw = obj(d, "node") as unknown as WorkflowRunNodeDto | undefined;
      const nodeId = str(d, "nodeId") ?? raw?.id;
      if (!raw || !nodeId) break;
      const index = run.nodes.findIndex((node) => node.id === nodeId);
      if (d.partial !== true) {
        // Legacy full snapshot: replace the node wholesale.
        if (index === -1) run.nodes.push({ ...raw });
        else run.nodes[index] = { ...raw };
        break;
      }
      // Partial progress: merge the changed fields over the known node, `null`
      // clears a field and `outputDelta` extends the streamed output.
      const current: Record<string, unknown> = index === -1 ? { id: nodeId, role: "" } : { ...run.nodes[index]! };
      for (const [key, value] of Object.entries(raw)) {
        if (value === null) delete current[key];
        else current[key] = value;
      }
      const delta = str(d, "outputDelta");
      if (delta !== undefined) {
        current.output = (typeof current.output === "string" ? current.output : "") + delta;
      }
      const merged = current as unknown as WorkflowRunNodeDto;
      if (index === -1) run.nodes.push(merged);
      else run.nodes[index] = merged;
      break;
    }
    case "workflow/run-completed": {
      const run = model.workflowRun;
      if (!run || run.id !== (str(d, "runId") ?? run.id)) break;
      const status = str(d, "status");
      if (status === "done" || status === "error" || status === "stopped") run.status = status;
      run.finishedAt = num(d, "finishedAt") ?? ev.time;
      if (typeof d.result === "string") run.result = d.result;
      if (typeof d.interrupted === "boolean") run.interrupted = d.interrupted;
      break;
    }
    case "fusion/started": {
      model.fusionPrompt = str(d, "prompt") ?? "";
      const models = strArr(d, "models");
      model.fusion = {
        id: str(d, "fusionId") ?? "",
        answer: "",
        weights: models.map((m) => ({ model: m, weight: 0 })),
        disagreements: [],
        sources: [],
        status: "running",
      };
      break;
    }
    case "fusion/completed": {
      const weightsRaw = Array.isArray(d.weights) ? d.weights : [];
      const weights: FusionWeightDto[] = weightsRaw
        .map((raw) => {
          const w = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
          return { model: str(w, "model") ?? "", weight: num(w, "weight") ?? 0 };
        })
        .filter((w) => w.model);
      const status = str(d, "status");
      const sourcesRaw = Array.isArray(d.sources) ? d.sources : [];
      const sources = sourcesRaw
        .map((raw) => {
          const source = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
          return { model: str(source, "model") ?? "", answer: str(source, "answer") ?? "" };
        })
        .filter((source) => source.model);
      model.fusion = {
        id: str(d, "fusionId") ?? model.fusion?.id ?? "",
        answer: str(d, "answer") ?? "",
        weights,
        disagreements: strArr(d, "disagreements"),
        sources,
        status: status === "failed" || status === "running" || status === "completed" ? status : "completed",
        ...(str(d, "error") ? { error: str(d, "error") } : {}),
      };
      break;
    }
    default:
      runWebReducers(model, ev);
      break; // Unregistered session/*, context/*, compaction/*, etc. are ignored.
  }
  if (model.keepAliveTurn && model.messages.length > messageCountBefore) dropKeepAliveRows(model, messageCountBefore);
  // A soft rewind may be staged while the runtime is still working. Any new
  // rows from that stale turn remain part of the reversible hidden tail until
  // Restore or the replacement send resolves the marker. Timeline selects the
  // current activity group back out for live presentation without making it
  // effective model history.
  if (model.rewind && ev.seq > model.rewind.markerSeq) {
    for (let index = messageCountBefore; index < model.messages.length; index += 1) {
      const message = model.messages[index]!;
      if (message.undone) continue;
      message.undone = true;
      message.rewindMarkerSeq = model.rewind.markerSeq;
      touch(message);
    }
  }
  model.version += 1;
  return model;
}

export function buildModel(events: readonly SessionEvent[]): RenderModel {
  const model = emptyModel();
  for (const ev of events) reduceEvent(model, ev);
  return model;
}

/** Copy a model so React reference checks observe the update: fresh top-level
 *  object and fresh top-level arrays. Individual message/turn/goal objects are
 *  shared — reduceEvent mutates those in place and nothing in the app keys
 *  memoization off their identity (Timeline keys off `version`, Header off
 *  `model`/`model.messages`). The lookup index carries over so the delta fold
 *  doesn't rescan messages. */
export function cloneModel(src: RenderModel): RenderModel {
  const model: RenderModel = {
    ...src,
    messages: src.messages.slice(),
    permissions: src.permissions.slice(),
    questions: src.questions.slice(),
    secrets: src.secrets.slice(),
    totals: { ...src.totals },
    workflowRun: src.workflowRun
      ? { ...src.workflowRun, layers: src.workflowRun.layers.map((layer) => layer.slice()), nodes: src.workflowRun.nodes.map((node) => ({ ...node })) }
      : null,
    changedFiles: src.changedFiles.slice(),
  };
  const idx = messageIndexes.get(src);
  if (idx) messageIndexes.set(model, { assistants: new Map(idx.assistants), tools: new Map(idx.tools), positions: idx.positions });
  return model;
}

// Revision metadata is outside the replay model. A stream-only batch mutates
// existing messages with their captured `rev`, but cannot change array shape
// or lookup keys. Views get a fresh array identity without copying its prefix.
const streamArrayRoots = new WeakMap<RenderMessage[], RenderMessage[]>();
const frontiers = new WeakMap<RenderModel, { epoch: object; fromIndex: number; streamOnly?: true }>();
export function modelChangeFrontier(model: RenderModel): { epoch: object; fromIndex: number; streamOnly?: true } {
  let value = frontiers.get(model);
  if (!value) { value = { epoch: {}, fromIndex: 0 }; frontiers.set(model, value); }
  return value;
}

function cloneStreamModel(src: RenderModel, fromIndex: number): RenderModel {
  const root = streamArrayRoots.get(src.messages) ?? src.messages;
  const messages = new Proxy(root, {});
  streamArrayRoots.set(messages, root);
  const model = { ...src, messages };
  const prior = frontiers.get(src);
  const epoch = modelChangeFrontier(src).epoch;
  frontiers.set(model, { epoch, fromIndex: prior?.streamOnly ? Math.min(prior.fromIndex, fromIndex) : fromIndex, streamOnly: true });
  messageIndexes.set(model, messageIndex(src));
  return model;
}

export interface ModelCache {
  /** Render model for exactly this events array. When `events` extends the
   *  last array seen for the session (the common live-append case), only the
   *  new tail is folded via reduceEvent; otherwise a full buildModel replay
   *  runs. The same array in → the same model out (stable references). */
  get(sessionId: string, events: readonly SessionEvent[]): RenderModel;
  /** Release a session's cached model (store eviction of non-active sessions). */
  drop(sessionId: string): void;
}

interface ModelCacheEntry {
  events: readonly SessionEvent[];
  lastSeq: number;
  model: RenderModel;
}

/** The store copies-on-append, so an unchanged prefix keeps the same event
 *  objects; any insert at or before the boundary shifts it to a different
 *  object and fails this identity check (→ full rebuild, which is rare:
 *  only out-of-order gap-fill takes that path). */
function extendsPrefix(prev: readonly SessionEvent[], next: readonly SessionEvent[]): boolean {
  if (next.length < prev.length) return false;
  if (prev.length === 0) return true;
  return next[prev.length - 1] === prev[prev.length - 1];
}

/** Incremental render-model cache (one entry per session). buildModel stays
 *  the pure reference implementation; equivalence is covered by tests. */
export function createModelCache(capacity = 32): ModelCache {
  const bySession = new Map<string, ModelCacheEntry>();
  return {
    get(sessionId, events) {
      const entry = bySession.get(sessionId);
      if (entry) { bySession.delete(sessionId); bySession.set(sessionId, entry); }
      if (entry && entry.events === events) return entry.model;
      let model: RenderModel;
      if (entry && extendsPrefix(entry.events, events)) {
        const index = messageIndex(entry.model);
        let fromIndex = Infinity;
        for (let i = entry.events.length; i < events.length; i++) {
          const event = events[i]!;
          if (event.type !== "assistant/chunk" && event.type !== "assistant/reasoning-chunk") { fromIndex = -1; break; }
          const message = index.assistants.get(str(event.data, "partId") ?? "");
          const position = message && index.positions.get(message);
          if (position === undefined) { fromIndex = -1; break; }
          fromIndex = Math.min(fromIndex, position);
        }
        model = fromIndex >= 0 && Number.isFinite(fromIndex) ? cloneStreamModel(entry.model, fromIndex) : cloneModel(entry.model);
        for (let i = entry.events.length; i < events.length; i += 1) reduceEvent(model, events[i]!);
      } else {
        model = buildModel(events);
      }
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
      bySession.set(sessionId, { events, lastSeq, model });
      while (bySession.size > Math.max(1, capacity)) bySession.delete(bySession.keys().next().value!);
      return model;
    },
    drop(sessionId) {
      bySession.delete(sessionId);
    },
  };
}
