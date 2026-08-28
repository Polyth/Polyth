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
  SessionEvent,
  TokenUsage,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import { extractChangedFiles } from "./pendingChanges.ts";
import { tr } from "./i18n/index.ts";
import { runWebReducers } from "./packages/reducers.ts";

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
  tokens?: TokenUsage;
  cost?: number;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  /** Final `assistant/message.time` — the semantic completion time, distinct
   *  from `time` (the first streamed chunk) per UX-MSG-ACTIONS. */
  completedAt?: number;
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

export type RenderMessage = UserMsg | AssistantMsg | ToolMsg | TaskActivityMsg | GithubConflictMsg;

export interface PendingPermission {
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: string;
  status: "pending" | "resolved";
  reply?: "once" | "always" | "reject";
  /** F18: resolved by the session's auto-accept policy, not a human click. */
  auto?: boolean;
  time: number;
  /** Server-generated, secret-redacted preview (WP15; old events lack it). */
  preview?: { title: string; lines: string[]; risk?: "low" | "medium" | "high" };
  allowedScopes?: Array<"once" | "session" | "project">;
}

export interface PendingQuestion {
  requestId: string;
  questions: JsonObject[];
  status: "pending" | "answered" | "rejected";
  answers?: JsonObject;
  time: number;
}

export interface PendingSecret {
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
  inputTokens: number;
  model?: ModelRef;
}

export type ContextGauge =
  | {
      known: true;
      inputTokens: number;
      contextTokens: number;
      percent: number;
      level: "green" | "yellow" | "red";
    }
  | {
      known: false;
      inputTokens: number;
      contextTokens: null;
      percent: null;
      level: "unknown";
    };

export interface TurnState {
  turnId: string;
  status: "working" | "stopped" | "aborted" | "failed";
  model?: ModelRef;
  agent?: string;
  reason?: string;
  error?: string;
  /** Event-derived wall-clock bounds of THIS turn (UX-MSG-ACTIONS): the footer
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
  /** Latest usage sample for the active/last turn (not lifetime totals). */
  contextUsage: ContextUsageState | null;
  turn: TurnState | null;
  goal: GoalState | null;
  multirun: MultirunDto | null;
  workflowRun: WorkflowRunDto | null;
  fusion: FusionDto | null;
  fusionPrompt: string;
  /** Latest revisioned task/subagent snapshots (WP8); replay-deterministic. */
  tasks: TaskListState | null;
  subagents: SubagentState | null;
  /** Edit-tool paths from the current/last turn; cleared by the next prompt. */
  changedFiles: string[];
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
    rewind: null,
    fork: null,
    version: 0,
    queueVersion: 0,
  };
}

export function contextGauge(model: Pick<RenderModel, "contextUsage">, contextTokens?: number): ContextGauge {
  const inputTokens = Math.max(0, model.contextUsage?.inputTokens ?? 0);
  if (!Number.isFinite(contextTokens) || !contextTokens || contextTokens <= 0) {
    return { known: false, inputTokens, contextTokens: null, percent: null, level: "unknown" };
  }
  const percent = Math.min(100, Math.max(0, Math.round((inputTokens / contextTokens) * 100)));
  return {
    known: true,
    inputTokens,
    contextTokens,
    percent,
    level: percent < 60 ? "green" : percent < 85 ? "yellow" : "red",
  };
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
}

const messageIndexes = new WeakMap<RenderModel, MessageIndex>();

function messageIndex(m: RenderModel): MessageIndex {
  let idx = messageIndexes.get(m);
  if (!idx) {
    idx = { assistants: new Map(), tools: new Map() };
    // First occurrence wins, matching the previous `messages.find(...)` scans.
    for (const msg of m.messages) {
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
  if (!idx.assistants.has(msg.partId)) idx.assistants.set(msg.partId, msg);
}
function pushTool(m: RenderModel, msg: ToolMsg): void {
  m.messages.push(msg);
  const idx = messageIndex(m);
  if (!idx.tools.has(msg.callId)) idx.tools.set(msg.callId, msg);
}

/** In-place message mutation marker (see UserMsg.rev). */
function touch(m: RenderMessage): void {
  m.rev = (m.rev ?? 0) + 1;
}

export function reduceEvent(model: RenderModel, ev: SessionEvent): RenderModel {
  const d = ev.data;
  // Queue events carry no message payload (the durable queue is REST-read);
  // this counter is the refetch signal. They still reach package reducers.
  if (ev.type.startsWith("queue/") || ev.type === "delivery/fallback-queued") {
    model.queueVersion += 1;
  }
  switch (ev.type) {
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
    case "user/message": {
      const text = str(d, "text") ?? "";
      const raw = str(d, "raw");
      if (d.githubConflictResolution !== true) {
        const msg: UserMsg = { kind: "user", id: ev.id, eventSeq: ev.seq, text, time: ev.time };
        if (raw !== undefined && raw !== text) msg.raw = raw;
        // Attachment pills on the message (F2): keep only well-formed refs.
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
        };
        pushAssistant(model, m);
      }
      if (!m.model && model.turn?.model) m.model = model.turn.model;
      if (!m.agent && model.turn?.agent) m.agent = model.turn.agent;
      // Chunks make an answer visible before its canonical message row exists.
      // Actions such as pinning must nevertheless target that final row: the
      // server deliberately rejects transient `assistant/chunk` events.
      m.eventSeq = ev.seq;
      m.finalized = true;
      m.completedAt = ev.time; // semantic completion time, not first chunk
      const text = str(d, "text");
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
        t.status = "done";
        t.output = str(d, "output") ?? "";
        const title = str(d, tr("reduce.title"));
        if (title !== undefined) t.title = title;
        const metadata = obj(d, "metadata");
        if (metadata !== undefined) t.metadata = metadata;
        const lateInput = obj(d, "input");
        if (lateInput && Object.keys(t.input).length === 0) t.input = lateInput; // opencode fills input late
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
      for (const message of model.messages) {
        if (!message.undone && message.eventSeq >= atSeq) {
          message.undone = true;
          message.rewindMarkerSeq = ev.seq;
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
        const rawPreview = obj(d, "preview") as { title?: unknown; lines?: unknown; risk?: unknown } | undefined;
        const riskRaw = rawPreview?.risk;
        const risk: "low" | "medium" | "high" | undefined =
          riskRaw === "low" || riskRaw === "medium" || riskRaw === "high" ? riskRaw : undefined;
        const preview = rawPreview && typeof rawPreview.title === "string" && Array.isArray(rawPreview.lines)
          ? {
              title: rawPreview.title,
              lines: rawPreview.lines.filter((l): l is string => typeof l === "string"),
              ...(risk ? { risk } : {}),
            }
          : undefined;
        const scopes = strArr(d, "allowedScopes").filter(
          (s): s is "once" | "session" | "project" => s === "once" || s === "session" || s === "project",
        );
        model.permissions.push({
          requestId,
          permission: str(d, "permission") ?? "",
          patterns: strArr(d, "patterns"),
          tool: str(d, "tool"),
          status: "pending",
          time: ev.time,
          ...(preview ? { preview } : {}),
          ...(scopes.length > 0 ? { allowedScopes: scopes } : {}),
        });
      }
      break;
    }
    case "permission/resolved": {
      const requestId = str(d, "requestId") ?? "";
      const p = model.permissions.find((x) => x.requestId === requestId);
      if (p) {
        p.status = "resolved";
        const reply = str(d, "reply");
        if (reply === "once" || reply === "always" || reply === "reject") p.reply = reply;
        if (d.auto === true) p.auto = true; // F18: policy-approved, no human click
      }
      break;
    }
    case "question/asked": {
      const requestId = str(d, "requestId") ?? "";
      if (!model.questions.some((q) => q.requestId === requestId)) {
        model.questions.push({
          requestId,
          questions: Array.isArray(d.questions) ? (d.questions as JsonObject[]) : [],
          status: "pending",
          time: ev.time,
        });
      }
      break;
    }
    case "question/answered": {
      const requestId = str(d, "requestId") ?? "";
      const q = model.questions.find((x) => x.requestId === requestId);
      if (q) {
        q.status = "answered";
        const answers = obj(d, "answers");
        if (answers !== undefined) q.answers = answers;
      }
      break;
    }
    case "secret/requested": {
      const requestId = str(d, "requestId") ?? "";
      if (!model.secrets.some((secret) => secret.requestId === requestId)) {
        model.secrets.push({
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
    case "turn/started": {
      const turnModel = obj(d, "model") as ModelRef | undefined;
      model.turn = {
        turnId: str(d, "turnId") ?? "",
        status: "working",
        model: turnModel,
        agent: str(d, "agent"),
        startedAt: ev.time,
      };
      model.contextUsage = { inputTokens: 0, ...(turnModel ? { model: turnModel } : {}) };
      break;
    }
    case "turn/stopped": {
      const reason = str(d, "reason");
      const status: TurnState["status"] =
        reason === "aborted" ? "aborted" : reason === "error" ? "failed" : "stopped";
      const t = model.turn;
      if (t) {
        t.status = status;
        t.reason = reason;
        t.stoppedAt = ev.time;
        const error = str(d, "error");
        if (error !== undefined) t.error = error;
      } else {
        // Unmatched stop (copied/partial log): no startedAt, so no duration.
        model.turn = { turnId: str(d, "turnId") ?? "", status, reason, error: str(d, "error"), stoppedAt: ev.time };
      }
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
        const usageModel = obj(d, "model") as ModelRef | undefined;
        model.contextUsage = {
          inputTokens: Math.max(0, t.input ?? 0),
          ...(usageModel ? { model: usageModel } : model.contextUsage?.model ? { model: model.contextUsage.model } : {}),
        };
      }
      if (cost !== undefined) model.totals.cost += cost;
      // Per-turn usage, kept apart from lifetime totals: a forked child's
      // footer must reflect its own terminal turn, never inherited sums.
      if (model.turn && (t || cost !== undefined)) {
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
        const note = str(d, "note");
        if (note !== undefined) model.goal.lastReason = note;
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
        ...(obj(d, "options")
          ? { options: obj(d, "options") as unknown as Required<WorkflowRunOptionsDto> }
          : {}),
        status: "running",
        startedAt: num(d, "startedAt") ?? ev.time,
        layers,
        nodes,
      };
      break;
    }
    case "workflow/node-progress": {
      const run = model.workflowRun;
      if (!run || run.id !== (str(d, "runId") ?? run.id)) break;
      const raw = obj(d, "node") as unknown as WorkflowRunNodeDto | undefined;
      const nodeId = str(d, "nodeId") ?? raw?.id;
      if (!raw || !nodeId) break;
      const index = run.nodes.findIndex((node) => node.id === nodeId);
      if (index === -1) run.nodes.push({ ...raw });
      else run.nodes[index] = { ...raw };
      break;
    }
    case "workflow/run-completed": {
      const run = model.workflowRun;
      if (!run || run.id !== (str(d, "runId") ?? run.id)) break;
      const status = str(d, "status");
      if (status === "done" || status === "error" || status === "stopped") run.status = status;
      run.finishedAt = num(d, "finishedAt") ?? ev.time;
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
  if (idx) messageIndexes.set(model, { assistants: new Map(idx.assistants), tools: new Map(idx.tools) });
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
export function createModelCache(): ModelCache {
  const bySession = new Map<string, ModelCacheEntry>();
  return {
    get(sessionId, events) {
      const entry = bySession.get(sessionId);
      if (entry && entry.events === events) return entry.model;
      let model: RenderModel;
      if (entry && extendsPrefix(entry.events, events)) {
        model = cloneModel(entry.model);
        for (let i = entry.events.length; i < events.length; i += 1) reduceEvent(model, events[i]!);
      } else {
        model = buildModel(events);
      }
      const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
      bySession.set(sessionId, { events, lastSeq, model });
      return model;
    },
    drop(sessionId) {
      bySession.delete(sessionId);
    },
  };
}
