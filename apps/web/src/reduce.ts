// DOM-free event → render-model reducer. Pure data in, pure data out; used by
// the store, the views and tests. Replaying the same event list in order
// reconstructs an identical model (session log invariant).
import type {
  JsonObject,
  ModelRef,
  SessionEvent,
  TokenUsage,
} from "@polyth/contracts";

export interface UserMsg {
  kind: "user";
  id: string;
  text: string;
  raw?: string;
  time: number;
}

export interface AssistantMsg {
  kind: "assistant";
  id: string; // partId
  partId: string;
  text: string;
  reasoning: string;
  finalized: boolean; // assistant/message seen
  model?: ModelRef;
  agent?: string;
  tokens?: TokenUsage;
  cost?: number;
  time: number;
}

export interface ToolMsg {
  kind: "tool";
  id: string; // callId
  callId: string;
  tool: string;
  input: JsonObject;
  output?: string;
  error?: string;
  title?: string;
  status: "pending" | "done" | "error";
  time: number;
  finishTime?: number;
}

export type RenderMessage = UserMsg | AssistantMsg | ToolMsg;

export interface PendingPermission {
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: string;
  status: "pending" | "resolved";
  reply?: "once" | "always" | "reject";
  time: number;
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

export interface TurnState {
  turnId: string;
  status: "working" | "stopped" | "aborted" | "failed";
  model?: ModelRef;
  agent?: string;
  reason?: string;
  error?: string;
}

export interface RenderModel {
  messages: RenderMessage[];
  permissions: PendingPermission[];
  questions: PendingQuestion[];
  totals: Totals;
  turn: TurnState | null;
  goal: GoalState | null;
  version: number; // bumps on every applied event (cheap change signal)
}

export function emptyModel(): RenderModel {
  return {
    messages: [],
    permissions: [],
    questions: [],
    totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    turn: null,
    goal: null,
    version: 0,
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
      const msg: UserMsg = { kind: "user", id: ev.id, text, time: ev.time };
      if (raw !== undefined && raw !== text) msg.raw = raw;
      model.messages.push(msg);
      break;
    }
    case "assistant/chunk":
    case "assistant/reasoning-chunk": {
      const partId = str(d, "partId") ?? "";
      let m = findAssistant(model, partId);
      if (!m) {
        m = { kind: "assistant", id: partId, partId, text: "", reasoning: "", finalized: false, time: ev.time };
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
        m = { kind: "assistant", id: partId, partId, text: "", reasoning: "", finalized: false, time: ev.time };
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
    case "permission/requested": {
      const requestId = str(d, "requestId") ?? "";
      if (!model.permissions.some((p) => p.requestId === requestId)) {
        model.permissions.push({
          requestId,
          permission: str(d, "permission") ?? "",
          patterns: strArr(d, "patterns"),
          tool: str(d, "tool"),
          status: "pending",
          time: ev.time,
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
      model.turn = {
        turnId: str(d, "turnId") ?? "",
        status: "working",
        model: obj(d, "model") as ModelRef | undefined,
        agent: str(d, "agent"),
      };
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
    default:
      break; // session/*, context/*, compaction/*, git/snapshot, etc: ignore
  }
  model.version += 1;
  return model;
}

export function buildModel(events: readonly SessionEvent[]): RenderModel {
  const model = emptyModel();
  for (const ev of events) reduceEvent(model, ev);
  return model;
}