// Client API v1: the stable surface third-party apps build on. Polyth's own UI
// keeps its internal routes and event log; this module is the published shape
// of what an app sees. Additive changes only within a version, and a client
// ignores event types and fields it does not know.
//
// Browser-safe and dependency-free: `@polyth/client` and non-TypeScript
// consumers read the same shapes (see docs/api/client-v1.openapi.json).

/** Prefix of every Client API route. */
export const CLIENT_API_PREFIX = "/api/v1";

export interface ClientAccount {
  userId: string;
  spaceId: string;
  /** The approved app name. */
  app?: string;
  grants: string[];
  version: string;
}

export interface ClientProject {
  id: string;
  name: string;
  /** Project folder on the Polyth server, not on the app's machine. */
  path: string;
}

export interface ClientModel {
  providerId: string;
  modelId: string;
  name: string;
  harnessId?: string;
}

/** A chat. `waiting` means the agent needs an answer: see `pending`. */
export interface ClientSession {
  id: string;
  projectId: string;
  /** Set when this chat is a subagent of another chat. */
  parentId?: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  pending: { permissions: number; questions: number };
}

export interface ClientSessionPage {
  sessions: ClientSession[];
  /** Pass as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
}

export interface ClientCreateSession {
  projectId: string;
  title?: string;
  model?: { providerId: string; modelId: string };
  harnessId?: string;
  /** Reuse after a lost response: it can never create a second chat. */
  clientOperationId?: string;
}

export interface ClientSendMessage {
  text: string;
  /** How a message meets a running turn. Default: run now, or queue. */
  delivery?: "normal" | "queue" | "steer" | "interrupt";
  model?: { providerId: string; modelId: string };
  /** Reuse after a lost response: it can never be delivered twice. */
  clientOperationId?: string;
}

export interface ClientSendResult {
  turnId?: string;
  queueId?: string;
  queued: boolean;
}

export interface ClientPermissionRequest {
  kind: "permission";
  requestId: string;
  permission: string;
  patterns: string[];
  tool?: string;
}

export interface ClientQuestionRequest {
  kind: "question";
  requestId: string;
  questions: Array<Record<string, unknown>>;
}

export type ClientPendingRequest = ClientPermissionRequest | ClientQuestionRequest;

interface ClientEventBase {
  /** Position in the chat's history; resume with `afterSeq` / `Last-Event-ID`. */
  seq: number;
  /** Milliseconds since the epoch. */
  time: number;
}

/** What happened in a chat. Assistant text arrives as `message.delta` while it
 *  is written, then once whole as `message.assistant`. A harness reports a tool
 *  with `tool.called`, `tool.started` or both, then one outcome per `callId`. */
export type ClientEvent = ClientEventBase & (
  | { type: "message.user"; text: string; author?: { name?: string; app?: string } }
  | { type: "message.delta"; partId: string; text: string }
  | { type: "message.assistant"; partId: string; text: string }
  | { type: "tool.called"; callId: string; tool: string; input: Record<string, unknown> }
  | { type: "tool.started"; callId: string; tool: string; input: Record<string, unknown> }
  | { type: "tool.finished"; callId: string; tool: string; output: string }
  | { type: "tool.failed"; callId: string; tool: string; error: string }
  | { type: "permission.requested"; requestId: string; permission: string; patterns: string[]; tool?: string }
  | { type: "permission.resolved"; requestId: string; reply: string }
  | { type: "permission.expired"; requestId: string }
  | { type: "question.asked"; requestId: string; questions: Array<Record<string, unknown>> }
  | { type: "question.answered"; requestId: string }
  | { type: "question.expired"; requestId: string }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.finished"; reason: string; error?: string }
);

export interface ClientEventPage {
  events: ClientEvent[];
  /** Pass as `afterSeq` next. Advances past history an app does not see. */
  cursor: number;
  /** False while more history is already available past `cursor`. */
  complete: boolean;
}

/** Canonical event fields this mapping reads. */
interface ClientEventSource {
  seq: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const records = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.map(record) : [];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * The published view of one canonical event, or null when apps do not see it.
 * An allowlist by construction: a new canonical event or field stays private
 * until it is added here, and recovery prompts, memory, runtime receipts and
 * secret requests never leave this module.
 */
export function clientEventFromSessionEvent(event: ClientEventSource): ClientEvent | null {
  const { seq, time, data } = event;
  const base = { seq, time };
  switch (event.type) {
    case "user/message": {
      if (data.hidden === true || data.hiddenUserMessage === true) return null;
      const author = record(data.author);
      const name = text(author.name);
      const app = author.via === "app" ? text(author.viaName) : "";
      return {
        ...base,
        type: "message.user",
        text: text(data.text),
        ...(name || app ? { author: { ...(name ? { name } : {}), ...(app ? { app } : {}) } } : {}),
      };
    }
    case "assistant/chunk":
      return { ...base, type: "message.delta", partId: text(data.partId), text: text(data.text) };
    case "assistant/message":
      return { ...base, type: "message.assistant", partId: text(data.partId), text: text(data.text) };
    case "tool/call":
      return { ...base, type: "tool.called", callId: text(data.callId), tool: text(data.tool), input: record(data.input) };
    case "tool/started":
      return { ...base, type: "tool.started", callId: text(data.callId), tool: text(data.tool), input: record(data.input) };
    case "tool/result":
      return { ...base, type: "tool.finished", callId: text(data.callId), tool: text(data.tool), output: text(data.output) };
    case "tool/error":
      return { ...base, type: "tool.failed", callId: text(data.callId), tool: text(data.tool), error: text(data.error) };
    case "permission/requested":
      return {
        ...base,
        type: "permission.requested",
        requestId: text(data.requestId),
        permission: text(data.permission),
        patterns: strings(data.patterns),
        ...(typeof data.tool === "string" ? { tool: data.tool } : {}),
      };
    case "permission/resolved":
      return { ...base, type: "permission.resolved", requestId: text(data.requestId), reply: text(data.reply) };
    case "permission/expired":
      return { ...base, type: "permission.expired", requestId: text(data.requestId) };
    case "question/asked":
      return { ...base, type: "question.asked", requestId: text(data.requestId), questions: records(data.questions) };
    case "question/answered":
      return { ...base, type: "question.answered", requestId: text(data.requestId) };
    case "question/expired":
      return { ...base, type: "question.expired", requestId: text(data.requestId) };
    case "turn/started":
      return { ...base, type: "turn.started", turnId: text(data.turnId) };
    case "turn/stopped": {
      const error = text(data.error) || text(record(data.error).message) || text(data.message);
      return { ...base, type: "turn.finished", reason: text(data.reason) || "completed", ...(error ? { error } : {}) };
    }
    default:
      return null;
  }
}

/** The requests still waiting for an answer after `events`, oldest first.
 *  A request handed to a parent chat is answered there, not here. */
export function pendingRequestsFromEvents(events: readonly ClientEventSource[]): ClientPendingRequest[] {
  const open = new Map<string, ClientPendingRequest>();
  for (const event of events) {
    const requestId = text(event.data.requestId);
    if (!requestId) continue;
    switch (event.type) {
      case "permission/requested":
        open.set(`p:${requestId}`, {
          kind: "permission",
          requestId,
          permission: text(event.data.permission),
          patterns: strings(event.data.patterns),
          ...(typeof event.data.tool === "string" ? { tool: event.data.tool } : {}),
        });
        break;
      case "permission/resolved":
      case "permission/expired":
        open.delete(`p:${requestId}`);
        break;
      case "question/asked":
        open.set(`q:${requestId}`, { kind: "question", requestId, questions: records(event.data.questions) });
        break;
      case "question/answered":
      case "question/expired":
        open.delete(`q:${requestId}`);
        break;
    }
  }
  return [...open.values()];
}
