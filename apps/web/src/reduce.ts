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
} from "@polyth/contracts";
import { extractChangedFiles } from "./pendingChanges.ts";

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
}

export interface AssistantMsg {
  kind: "assistant";
  id: string; // partId
  partId: string;
  eventSeq: number;
  text: string;
  reasoning: string;
  finalized: boolean; // assistant/message seen
  model?: ModelRef;
  agent?: string;
  tokens?: TokenUsage;
  cost?: number;
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
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
  status: "pending" | "done" | "error";
  undone?: boolean;
  rewindMarkerSeq?: number;
  time: number;
  finishTime?: number;
  changedFiles?: string[];
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
}

export type RenderMessage = UserMsg | AssistantMsg | ToolMsg | TaskActivityMsg;

export interface PendingPermission {
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: string;
  status: "pending" | "resolved";
  reply?: "once" | "always" | "reject";
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
  totals: Totals;
  /** Latest usage sample for the active/last turn (not lifetime totals). */
  contextUsage: ContextUsageState | null;
  turn: TurnState | null;
  goal: GoalState | null;
  multirun: MultirunDto | null;
  fusion: FusionDto | null;
  fusionPrompt: string;
  /** Latest revisioned task/subagent snapshots (WP8); replay-deterministic. */
  tasks: TaskListState | null;
  subagents: SubagentState | null;
  /** Edit-tool paths from the current/last turn; cleared by the next prompt. */
  changedFiles: string[];
  rewind: { markerSeq: number; atSeq: number; restoredText?: string } | null;
  version: number; // bumps on every applied event (cheap change signal)
}

export function emptyModel(): RenderModel {
  return {
    messages: [],
    permissions: [],
    questions: [],
    totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    contextUsage: null,
    turn: null,
    goal: null,
    multirun: null,
    fusion: null,
    fusionPrompt: "",
    tasks: null,
    subagents: null,
    changedFiles: [],
    rewind: null,
    version: 0,
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

function findAssistant(m: RenderModel, partId: string): AssistantMsg | undefined {
  return m.messages.find((x): x is AssistantMsg => x.kind === "assistant" && x.partId === partId);
}
function findTool(m: RenderModel, callId: string): ToolMsg | undefined {
  return m.messages.find((x): x is ToolMsg => x.kind === "tool" && x.callId === callId);
}

export function reduceEvent(model: RenderModel, ev: SessionEvent): RenderModel {
  const d = ev.data;
  switch (ev.type) {
    case "user/message": {
      const text = str(d, "text") ?? "";
      const raw = str(d, "raw");
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
      model.changedFiles = [];
      break;
    }
    case "assistant/chunk":
    case "assistant/reasoning-chunk": {
      const partId = str(d, "partId") ?? "";
      let m = findAssistant(model, partId);
      if (!m) {
        m = { kind: "assistant", id: partId, partId, eventSeq: ev.seq, text: "", reasoning: "", finalized: false, time: ev.time };
        model.messages.push(m);
      }
      const text = str(d, "text") ?? "";
      if (ev.type === "assistant/chunk") m.text += text;
      else m.reasoning += text;
      break;
    }
    case "assistant/message": {
      const partId = str(d, "partId") ?? "";
      let m = findAssistant(model, partId);
      if (!m) {
        m = { kind: "assistant", id: partId, partId, eventSeq: ev.seq, text: "", reasoning: "", finalized: false, time: ev.time };
        model.messages.push(m);
      }
      m.finalized = true;
      const text = str(d, "text");
      if (text !== undefined) m.text = text;
      const reasoning = str(d, "reasoning");
      if (reasoning !== undefined) m.reasoning = reasoning;
      const tokens = obj(d, "tokens") as TokenUsage | undefined;
      if (tokens !== undefined) m.tokens = tokens;
      const cost = num(d, "cost");
      if (cost !== undefined) m.cost = cost;
      break;
    }
    case "tool/call": {
      const callId = str(d, "callId") ?? "";
      model.messages.push({
        kind: "tool",
        id: callId,
        callId,
        eventSeq: ev.seq,
        tool: str(d, "tool") ?? "",
        input: obj(d, "input") ?? {},
        status: "pending",
        time: ev.time,
      });
      break;
    }
    case "tool/result": {
      const t = findTool(model, str(d, "callId") ?? "");
      if (t) {
        t.status = "done";
        t.output = str(d, "output") ?? "";
        const title = str(d, "title");
        if (title !== undefined) t.title = title;
        const lateInput = obj(d, "input");
        if (lateInput && Object.keys(t.input).length === 0) t.input = lateInput; // opencode fills input late
        const changedFiles = extractChangedFiles(t.tool, lateInput ?? t.input, obj(d, "metadata"));
        if (changedFiles.length > 0) {
          t.changedFiles = changedFiles;
          model.changedFiles = [...new Set([...model.changedFiles, ...changedFiles])];
        }
        t.finishTime = ev.time;
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
      } else {
        model.messages.push({
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
      for (const message of model.messages) {
        if (!message.undone && message.eventSeq >= atSeq) {
          message.undone = true;
          message.rewindMarkerSeq = ev.seq;
        }
      }
      const restoredText = str(d, "restoredText");
      model.rewind = {
        markerSeq: ev.seq,
        atSeq,
        ...(restoredText !== undefined ? { restoredText } : {}),
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
          }
        }
      }
      model.rewind = null;
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
    case "turn/started": {
      const turnModel = obj(d, "model") as ModelRef | undefined;
      model.turn = {
        turnId: str(d, "turnId") ?? "",
        status: "working",
        model: turnModel,
        agent: str(d, "agent"),
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
        const error = str(d, "error");
        if (error !== undefined) t.error = error;
      } else {
        model.turn = { turnId: str(d, "turnId") ?? "", status, reason, error: str(d, "error") };
      }
      break;
    }
    case "usage/recorded": {
      const t = obj(d, "tokens") as TokenUsage | undefined;
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
      const cost = num(d, "cost");
      if (cost !== undefined) model.totals.cost += cost;
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
    case "goal/completed":
    case "goal/stuck":
    case "goal/stopped":
    case "goal/paused":
    case "goal/resumed": {
      if (model.goal) {
        const statusMap: Record<string, GoalState["status"]> = {
          "goal/completed": "completed",
          "goal/stuck": "stuck",
          "goal/stopped": "stopped",
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
    case "fusion/started": {
      model.fusionPrompt = str(d, "prompt") ?? "";
      const models = strArr(d, "models");
      model.fusion = {
        id: str(d, "fusionId") ?? "",
        answer: "",
        weights: models.map((m) => ({ model: m, weight: 0 })),
        disagreements: [],
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
      model.fusion = {
        id: str(d, "fusionId") ?? model.fusion?.id ?? "",
        answer: str(d, "answer") ?? "",
        weights,
        disagreements: strArr(d, "disagreements"),
        status: status === "failed" || status === "running" || status === "completed" ? status : "completed",
        ...(str(d, "error") ? { error: str(d, "error") } : {}),
      };
      break;
    }
    default:
      break; // session/*, context/*, compaction/*, git/snapshot, walkthrough/*, etc: ignore
  }
  model.version += 1;
  return model;
}

export function buildModel(events: readonly SessionEvent[]): RenderModel {
  const model = emptyModel();
  for (const ev of events) reduceEvent(model, ev);
  return model;
}