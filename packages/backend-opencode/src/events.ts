import type {
  CanonicalEventInput,
  JsonObject,
  ObservationArtifactKind,
  ObservationCheckpoint,
  ObservationIdentity,
  ObservationIngestionResult,
  RateLimitRetryHint,
  RuntimeEvent,
  RuntimeLocation,
  RuntimeSnapshot,
  TokenUsage,
} from "@polyth/contracts";
import type { Store as SessionStore } from "@polyth/session";
import { classifyProviderLimit } from "./providerLimit.ts";

export interface OcEvent {
  id?: string;
  type?: string;
  properties?: Record<string, unknown>;
  durable?: Record<string, unknown>;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const serialized = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** V2's native stream uses `{ type, data }`. Most compatibility events need
 * only the field rename; native session.next events are projected onto the
 * established event vocabulary so the protocol-neutral reducer can consume
 * either stream without a UI or session-store branch. */
const normalizeV2Event = (
  type: string,
  data: Record<string, unknown>,
): { type: string; properties: Record<string, unknown> } => {
  const sessionID = data.sessionID;
  const messageID = data.assistantMessageID;
  const timestamp = data.timestamp;
  if (type === "session.next.prompted" || type === "session.next.prompt.admitted") {
    return {
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: data.messageID,
          role: "user",
          sessionID,
          time: { created: timestamp },
        },
      },
    };
  }
  if (type === "session.next.step.started" || type === "session.next.step.ended") {
    const model = asRecord(data.model);
    return {
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: messageID,
          role: "assistant",
          sessionID,
          ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
          ...(typeof model?.providerID === "string" ? { providerID: model.providerID } : {}),
          ...(typeof model?.id === "string" ? { modelID: model.id } : {}),
          ...(typeof data.cost === "number" ? { cost: data.cost } : {}),
          ...(asRecord(data.tokens) ? { tokens: data.tokens } : {}),
          time: type === "session.next.step.ended"
            ? { created: timestamp, completed: timestamp }
            : { created: timestamp },
        },
      },
    };
  }
  if (type === "session.next.step.failed") {
    return {
      type: "session.error",
      properties: { sessionID, error: data.error },
    };
  }
  const textKind = type.includes(".reasoning.") ? "reasoning" : "text";
  const partID = textKind === "reasoning" ? data.reasoningID : data.textID;
  if (
    type === "session.next.text.started"
    || type === "session.next.reasoning.started"
  ) {
    return {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          id: partID,
          type: textKind,
          text: "",
          messageID,
          sessionID,
          time: { start: timestamp },
        },
      },
    };
  }
  if (
    type === "session.next.text.delta"
    || type === "session.next.reasoning.delta"
  ) {
    return {
      type: "message.part.delta",
      properties: {
        sessionID,
        messageID,
        partID,
        field: textKind,
        delta: data.delta,
      },
    };
  }
  if (
    type === "session.next.text.ended"
    || type === "session.next.reasoning.ended"
  ) {
    return {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          id: partID,
          type: textKind,
          text: data.text,
          messageID,
          sessionID,
          time: { start: timestamp, end: timestamp },
        },
      },
    };
  }
  if (type === "session.next.tool.called") {
    return {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          id: data.callID,
          type: "tool",
          callID: data.callID,
          tool: data.tool,
          messageID,
          sessionID,
          state: { status: "running", input: asRecord(data.input) ?? {} },
        },
      },
    };
  }
  if (type === "session.next.tool.success" || type === "session.next.tool.failed") {
    const failed = type === "session.next.tool.failed";
    return {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          id: data.callID,
          type: "tool",
          callID: data.callID,
          tool: "tool",
          messageID,
          sessionID,
          state: failed
            ? { status: "error", input: {}, error: serialized(data.error) }
            : { status: "completed", input: {}, output: serialized(data.result) },
        },
      },
    };
  }
  return {
    type: type === "permission.v2.asked"
      ? "permission.asked"
      : type === "question.v2.asked"
        ? "question.asked"
        : type,
    properties: data,
  };
};

export const asOcEvent = (data: unknown): OcEvent | undefined => {
  if (!data || typeof data !== "object") return undefined;
  const rec = data as Record<string, unknown>;
  const nested = rec.payload;
  const src = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : rec;
  const type = typeof src.type === "string" ? src.type : undefined;
  if (!type) return undefined;
  const nativeData = asRecord(src.data);
  const normalized = nativeData
    ? normalizeV2Event(type, nativeData)
    : { type, properties: asRecord(src.properties) ?? {} };
  const id = typeof src.id === "string" ? src.id : undefined;
  const durable = asRecord(src.durable);
  return {
    id,
    type: normalized.type,
    properties: normalized.properties,
    ...(durable ? { durable } : {}),
  };
};

export const backendSessionId = (ev: OcEvent): string | undefined => {
  const p = ev.properties ?? {};
  if (typeof p.sessionID === "string") return p.sessionID;
  const part = p.part;
  if (part && typeof part === "object") {
    const sid = (part as Record<string, unknown>).sessionID;
    if (typeof sid === "string") return sid;
  }
  const info = p.info;
  if (info && typeof info === "object") {
    const sid = (info as Record<string, unknown>).sessionID;
    if (typeof sid === "string") return sid;
    const id = (info as Record<string, unknown>).id;
    if (typeof id === "string" && id.startsWith("ses")) return id;
  }
  return undefined;
};

const asJsonObject = (v: unknown): JsonObject => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as JsonObject;
};

const patternsOf = (p: Record<string, unknown>): string[] => {
  if (Array.isArray(p.patterns)) return p.patterns.filter((x) => typeof x === "string") as string[];
  if (typeof p.pattern === "string") return [p.pattern];
  if (Array.isArray(p.pattern)) return p.pattern.filter((x) => typeof x === "string") as string[];
  return [];
};

const tokensOf = (info: Record<string, unknown> | undefined): TokenUsage | undefined => {
  const t = asRecord(info?.tokens);
  if (!t) return undefined;
  const cache = asRecord(t.cache);
  return {
    input: Number(t.input ?? 0),
    output: Number(t.output ?? 0),
    reasoning: typeof t.reasoning === "number" ? t.reasoning : undefined,
    cacheRead: typeof cache?.read === "number" ? cache.read : undefined,
    cacheWrite: typeof cache?.write === "number" ? cache.write : undefined,
  };
};

export interface TranslateState {
  userMessageIds: Set<string>;
  toolCalls: Map<string, "pending" | "running" | "completed" | "error">;
  partText: Map<string, string>;
  partReasoning: Map<string, string>;
  // UX-MSG-ACTIONS: one-time part classification. A part is text OR reasoning
  // for its whole life; bytes that arrive before classification buffer in
  // pendingDelta and emit NOTHING until part.type/field resolves them, so an
  // unclassified reasoning stream can never be displayed as answer text.
  partKind: Map<string, "text" | "reasoning">;
  pendingDelta: Map<string, string>;
  emittedAssistant: Set<string>;
  emittedUsage: Set<string>;
  compactionParts: Set<string>;
  admittedTurnId?: string;
  abortingTurnId?: string;
  latestAssistantCompletion?: {
    messageId: string;
    revision: string;
    order: number;
    turnId?: string;
  };
  /** Legacy idle can arrive before the final assistant message. Keep it until
   * that completion makes the terminal turn unambiguous. */
  pendingTerminal?: {
    turnId: string;
    evidence: TerminalStateEvidence;
  };
  terminalizedTurnId?: string;
  lastTokens?: TokenUsage;
  lastCost?: number;
  // WP8: revisioned full snapshots of tasks and delegated agents. Revisions
  // are per-session monotonic so out-of-order application is detectable.
  taskRevision: number;
  lastTaskKey: string;
  subagentRevision: number;
  subagents: Map<string, { sessionId: string; label: string; status: string; currentTask?: string }>;
}

export const createTranslateState = (): TranslateState => ({
  userMessageIds: new Set(),
  toolCalls: new Map(),
  partText: new Map(),
  partReasoning: new Map(),
  partKind: new Map(),
  pendingDelta: new Map(),
  emittedAssistant: new Set(),
  emittedUsage: new Set(),
  compactionParts: new Set(),
  taskRevision: 0,
  lastTaskKey: "",
  subagentRevision: 0,
  subagents: new Map(),
});

export const admitTranslateTurn = (
  state: TranslateState,
  turnId: string,
): void => {
  state.admittedTurnId = turnId;
  state.abortingTurnId = undefined;
  state.pendingTerminal = undefined;
  state.latestAssistantCompletion = undefined;
};

export const finishTranslateTurn = (
  state: TranslateState,
  turnId: string,
): void => {
  if (state.admittedTurnId !== turnId) return;
  state.admittedTurnId = undefined;
  state.abortingTurnId = undefined;
  state.pendingTerminal = undefined;
  state.latestAssistantCompletion = undefined;
};

export const markTranslateTurnAborting = (
  state: TranslateState,
  turnId: string,
): void => {
  if (state.admittedTurnId === turnId) state.abortingTurnId = turnId;
};

/** First classification wins: later updates can never migrate already
 *  displayed reasoning into answer text (or vice versa). */
const classify = (
  state: TranslateState, partId: string, hint: "text" | "reasoning" | undefined,
): "text" | "reasoning" | undefined => {
  const existing = state.partKind.get(partId);
  if (existing) return existing;
  if (hint) state.partKind.set(partId, hint);
  return hint;
};

/** Append `delta` to the part's one canonical channel and emit its chunk.
 *  Any bytes buffered before classification drain first, in arrival order. */
const appendChunk = (
  state: TranslateState, out: RuntimeEvent[], partId: string, kind: "text" | "reasoning", delta: string,
): void => {
  const pending = state.pendingDelta.get(partId);
  if (pending) {
    state.pendingDelta.delete(partId);
    delta = pending + delta;
  }
  if (!delta) return;
  const store = kind === "reasoning" ? state.partReasoning : state.partText;
  store.set(partId, (store.get(partId) ?? "") + delta);
  out.push(
    kind === "reasoning"
      ? { type: "assistant/reasoning-chunk", partId, text: delta }
      : { type: "assistant/chunk", partId, text: delta },
  );
};

type TaskStatus = "pending" | "active" | "done" | "failed";
const TASK_STATUS: Record<string, TaskStatus> = {
  pending: "pending", in_progress: "active", active: "active",
  completed: "done", done: "done", cancelled: "failed", failed: "failed",
};

/** Normalize a todowrite tool input into a full task snapshot (or undefined). */
const taskItemsOf = (input: JsonObject): Array<{ id: string; text: string; status: TaskStatus }> | undefined => {
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return undefined;
  const items: Array<{ id: string; text: string; status: TaskStatus }> = [];
  for (let i = 0; i < todos.length; i++) {
    const t = asRecord(todos[i]);
    if (!t) continue;
    const text = typeof t.content === "string" ? t.content : typeof t.text === "string" ? t.text : "";
    if (!text) continue;
    items.push({
      id: typeof t.id === "string" ? t.id : String(i),
      text,
      status: TASK_STATUS[String(t.status ?? "pending")] ?? "pending",
    });
  }
  return items;
};

const subagentSnapshot = (state: TranslateState): RuntimeEvent => ({
  type: "subagent/snapshot",
  revision: ++state.subagentRevision,
  agents: [...state.subagents.values()],
});

export const translateOcEvent = (ev: OcEvent, state: TranslateState): RuntimeEvent[] => {
  const out: RuntimeEvent[] = [];
  const p = ev.properties ?? {};
  const type = ev.type ?? "";

  if (type === "session.updated") {
    const info = asRecord(p.info);
    const title = typeof info?.title === "string" ? info.title.trim() : "";
    // OpenCode emits a burst of placeholder "New session - <iso>" updates
    // before the semantic title lands. Those are not user-meaningful names
    // and Polyth surfaces treat them as placeholders, so translate only
    // non-placeholder titles.
    if (title && !/^new session - \d{4}-\d{2}-\d{2}t/i.test(title)) {
      out.push({ type: "session/title-generated", title });
    }
    return out;
  }

  if (type === "session.compacted") {
    out.push({
      type: "session/compacted",
      ...(ev.id ? { backendEventId: ev.id } : {}),
    });
    return out;
  }

  if (type === "message.updated") {
    const info = asRecord(p.info);
    if (info?.role === "user" && typeof info.id === "string") state.userMessageIds.add(info.id);
    if (info?.role === "assistant") {
      const tok = tokensOf(info);
      if (tok) state.lastTokens = tok;
      if (typeof info.cost === "number") state.lastCost = info.cost;
      const completed = asRecord(info?.time)?.completed;
      if (typeof completed === "number" && typeof info.id === "string" && info.id) {
        state.latestAssistantCompletion = {
          messageId: info.id,
          revision: explicitRevision(
            ev as unknown as Record<string, unknown>,
            p,
            info,
          ) ?? `completed:${completed}`,
          order: completed,
          ...(state.admittedTurnId ? { turnId: state.admittedTurnId } : {}),
        };
      }
      if (typeof completed === "number" && tok && typeof info.id === "string" && !state.emittedUsage.has(info.id)) {
        state.emittedUsage.add(info.id);
        out.push({
          type: "usage/recorded",
          model: {
            providerID: typeof info.providerID === "string" ? info.providerID : "opencode",
            modelID: typeof info.modelID === "string" ? info.modelID : "unknown",
          },
          tokens: tok,
          cost: typeof info.cost === "number" ? info.cost : undefined,
        });
      }
    }
    return out;
  }

  if (type === "message.part.delta") {
    const partId = typeof p.partID === "string" ? p.partID : "part";
    const delta = typeof p.delta === "string" ? p.delta : "";
    const field = typeof p.field === "string" ? p.field : undefined;
    const messageID = typeof p.messageID === "string" ? p.messageID : "";
    if (messageID && state.userMessageIds.has(messageID)) return out;
    if (!delta) return out;
    const hint = field === "reasoning" ? "reasoning" as const : field === "text" ? "text" as const : undefined;
    const kind = classify(state, partId, hint);
    if (!kind) {
      // untyped delta before classification: buffer, display nothing —
      // part.updated's part.type resolves it to exactly one channel later
      state.pendingDelta.set(partId, (state.pendingDelta.get(partId) ?? "") + delta);
      return out;
    }
    appendChunk(state, out, partId, kind, delta);
    return out;
  }

  if (type === "message.part.updated") {
    const part = asRecord(p.part);
    if (!part) return out;
    const partId = typeof part.id === "string" ? part.id : "part";
    const messageID = typeof part.messageID === "string" ? part.messageID : "";
    if (messageID && state.userMessageIds.has(messageID)) return out;
    const partType = part.type;
    const delta = typeof p.delta === "string" ? p.delta : undefined;

    if (partType === "text" || partType === "reasoning") {
      // classification is one-time: an already displayed reasoning part stays
      // reasoning even if a later update claims to be text (and vice versa)
      const kind = classify(state, partId, partType)!;
      const store = kind === "reasoning" ? state.partReasoning : state.partText;
      const text = typeof part.text === "string" ? part.text : "";
      if (delta) {
        appendChunk(state, out, partId, kind, delta);
      } else if (text) {
        // A full snapshot supersedes buffered pre-classification bytes (they
        // are contained in it) — emit only what is not yet displayed.
        state.pendingDelta.delete(partId);
        const prev = store.get(partId) ?? "";
        if (text.startsWith(prev) && text.length > prev.length) {
          out.push(
            kind === "reasoning"
              ? { type: "assistant/reasoning-chunk", partId, text: text.slice(prev.length) }
              : { type: "assistant/chunk", partId, text: text.slice(prev.length) },
          );
        }
        store.set(partId, text);
      } else {
        // classification-only update: resolve buffered bytes into the channel
        appendChunk(state, out, partId, kind, "");
      }
      // Independent finalization per channel. A finalized reasoning part is
      // the model-visible reasoning-only record; deriveMessages() skips its
      // empty text so it can never become an ordinary answer bubble.
      const time = asRecord(part.time);
      if (time && typeof time.end === "number" && !state.emittedAssistant.has(partId)) {
        state.emittedAssistant.add(partId);
        if (kind === "reasoning") {
          const reasoning = store.get(partId) ?? text;
          if (reasoning) out.push({ type: "assistant/message", partId, text: "", reasoning });
        } else {
          out.push({
            type: "assistant/message",
            partId,
            text: store.get(partId) ?? text,
            tokens: state.lastTokens,
            cost: state.lastCost,
          });
        }
      }
      return out;
    }

    if (partType === "compaction") {
      if (!state.compactionParts.has(partId)) {
        state.compactionParts.add(partId);
        out.push({
          type: "compaction/part-recorded",
          partId,
          ...(messageID ? { messageId: messageID } : {}),
          ...(typeof part.auto === "boolean" ? { auto: part.auto } : {}),
        });
      }
      return out;
    }

    if (partType === "tool") {
      const callId = typeof part.callID === "string" ? part.callID : partId;
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      const st = asRecord(part.state);
      const status = typeof st?.status === "string" ? st.status : "";
      const input = asJsonObject(st?.input);

      // ---- WP8: todo tools become full task snapshots ----------------------
      const toolLower = tool.toLowerCase().replace(/[^a-z]/g, "");
      if (toolLower === "todowrite" || toolLower === "todo") {
        const items = taskItemsOf(input);
        if (items && items.length > 0) {
          const key = JSON.stringify(items);
          if (key !== state.lastTaskKey) {
            state.lastTaskKey = key;
            out.push({ type: "task/snapshot", listId: "todo", revision: ++state.taskRevision, items });
          }
        }
        // fall through: the tool call/result itself still logs below
      }

      // ---- WP8: task tool = delegated subagent -----------------------------
      if (toolLower === "task") {
        const meta = asRecord(st?.metadata);
        const label =
          typeof input.description === "string" && input.description
            ? String(input.description)
            : typeof input.subagent_type === "string" ? String(input.subagent_type) : "subagent";
        const childSession =
          typeof meta?.sessionID === "string" ? String(meta.sessionID)
          : typeof meta?.sessionId === "string" ? String(meta.sessionId) : callId;
        const prev = state.subagents.get(callId);
        const nextStatus = status === "completed"
          ? "done"
          : status === "error"
            ? "failed"
            : status === "pending"
              ? "pending"
              : "running";
        if (!prev || prev.status !== nextStatus || prev.sessionId !== childSession) {
          state.subagents.set(callId, {
            sessionId: childSession,
            label,
            status: nextStatus,
            ...(typeof input.prompt === "string" && input.prompt
              ? { currentTask: String(input.prompt).split("\n")[0]!.slice(0, 140) }
              : {}),
          });
          out.push(subagentSnapshot(state));
        }
      }
      const previousToolStatus = state.toolCalls.get(callId);
      if (status === "pending" && previousToolStatus === undefined) {
        state.toolCalls.set(callId, "pending");
        out.push({ type: "tool/call", callId, tool, input, status: "pending" });
      }
      if (status === "running" && previousToolStatus !== "running") {
        state.toolCalls.set(callId, "running");
        if (previousToolStatus === "pending") {
          out.push({ type: "tool/started", callId, tool, input });
        } else {
          out.push({ type: "tool/call", callId, tool, input, status: "running" });
        }
      }
      if (status === "completed" && previousToolStatus !== "completed" && previousToolStatus !== "error") {
        if (!state.toolCalls.has(callId)) {
          state.toolCalls.set(callId, "running");
          out.push({ type: "tool/call", callId, tool, input, status: "running" });
        }
        state.toolCalls.set(callId, "completed");
        out.push({
          type: "tool/result",
          callId,
          tool,
          output: typeof st?.output === "string" ? st.output : "",
          title: typeof st?.title === "string" ? st.title : undefined,
          metadata: st?.metadata ? asJsonObject(st.metadata) : undefined,
          input, // may be richer than the call-time input (opencode fills it late)
        });
      }
      if (status === "error" && previousToolStatus !== "completed" && previousToolStatus !== "error") {
        if (!state.toolCalls.has(callId)) {
          state.toolCalls.set(callId, "running");
          out.push({ type: "tool/call", callId, tool, input, status: "running" });
        }
        state.toolCalls.set(callId, "error");
        out.push({
          type: "tool/error",
          callId,
          tool,
          error: typeof st?.error === "string" ? st.error : "tool error",
          input,
        });
      }
    }
    return out;
  }

  if (type === "permission.asked" || type === "permission.updated") {
    const req = asRecord(p.id ? p : asRecord(p.permission) ?? p) ?? p;
    const nested = typeof p.id === "string" ? p : req;
    const requestId =
      typeof nested.id === "string"
        ? nested.id
        : typeof p.permissionID === "string"
          ? p.permissionID
          : "";
    const permission =
      typeof nested.permission === "string"
        ? nested.permission
        : typeof nested.action === "string"
          ? nested.action
        : typeof nested.type === "string"
          ? nested.type
          : "unknown";
    const toolObj = asRecord(nested.tool);
    const tool =
      typeof nested.tool === "string"
        ? nested.tool
        : typeof toolObj?.callID === "string"
          ? String(toolObj.callID)
          : undefined;
    out.push({
      type: "permission/requested",
      requestId,
      permission,
      patterns: Array.isArray(nested.resources)
        ? nested.resources.filter((item): item is string => typeof item === "string")
        : patternsOf(nested),
      metadata: nested.metadata ? asJsonObject(nested.metadata) : undefined,
      tool,
    });
    return out;
  }

  if (type === "question.asked") {
    const requestId = typeof p.id === "string" ? p.id : "";
    const questions = Array.isArray(p.questions) ? (p.questions as JsonObject[]) : [];
    out.push({ type: "question/asked", requestId, questions });
  }

  return out;
};

/** Finalize the text and reasoning maps independently on idle. Parts still
 *  waiting for classification (pendingDelta) are never flushed as text —
 *  unclassified bytes stay invisible rather than becoming a wrong answer. */
export const flushAssistantOnIdle = (state: TranslateState): RuntimeEvent[] => {
  const out: RuntimeEvent[] = [];
  for (const [partId, reasoning] of state.partReasoning) {
    if (state.emittedAssistant.has(partId)) continue;
    if (!reasoning) continue;
    state.emittedAssistant.add(partId);
    out.push({ type: "assistant/message", partId, text: "", reasoning });
  }
  for (const [partId, text] of state.partText) {
    if (state.emittedAssistant.has(partId)) continue;
    if (!text) continue;
    state.emittedAssistant.add(partId);
    out.push({
      type: "assistant/message",
      partId,
      text,
      tokens: state.lastTokens,
      cost: state.lastCost,
    });
  }
  return out;
};

export type TerminalStateEvidence = Partial<ComparableRuntimeRevision> & {
  state: "idle" | "failed" | "interrupted";
};

export const terminalStateEvidenceOf = (
  ev: OcEvent,
): TerminalStateEvidence | undefined => {
  const properties = ev.properties ?? {};
  const status = ev.type === "session.idle"
    ? "idle"
    : ev.type === "session.error"
      ? "failed"
      : ev.type === "session.status"
        ? statusValue(properties.status)
        : "";
  if (status !== "idle" && status !== "failed" && status !== "interrupted") {
    return undefined;
  }
  const comparable = comparableStatusRevision(
    properties,
    asRecord(properties.status),
    asRecord(properties.error),
  );
  if (comparable) return { state: status, ...comparable };
  // Real legacy streams provide explicit terminal signals without revisions.
  // They are transport-order evidence for the facade's currently admitted
  // turn, not a fabricated monotonic watermark. Snapshot absence remains
  // non-authoritative and is handled independently by protocol reconciliation.
  return { state: status };
};

export const claimTerminalStateEvidence = (
  ev: OcEvent,
  state: TranslateState,
): ReturnType<typeof terminalStateEvidenceOf> => {
  const evidence = terminalStateEvidenceOf(ev);
  const turnId = state.admittedTurnId;
  if (!evidence) {
    const pending = state.pendingTerminal;
    if (!pending || !turnId || pending.turnId !== turnId || state.terminalizedTurnId === turnId) {
      return undefined;
    }
    if (
      pending.evidence.state === "idle"
      && state.abortingTurnId !== turnId
      && state.latestAssistantCompletion?.turnId !== turnId
    ) {
      return undefined;
    }
    state.pendingTerminal = undefined;
    state.terminalizedTurnId = turnId;
    return pending.evidence;
  }
  if (evidence.comparison) return evidence;
  if (!turnId || state.terminalizedTurnId === turnId) return undefined;
  if (
    evidence.state === "idle"
    && state.abortingTurnId !== turnId
    && state.latestAssistantCompletion?.turnId !== turnId
  ) {
    state.pendingTerminal = { turnId, evidence };
    return undefined;
  }
  state.terminalizedTurnId = turnId;
  return evidence;
};

export const errorMessageOf = (ev: OcEvent): string | undefined => {
  if (ev.type !== "session.error") return undefined;
  const err = asRecord(ev.properties?.error);
  const data = asRecord(err?.data);
  if (typeof data?.message === "string") return data.message;
  if (typeof err?.message === "string") return err.message;
  return "session error";
};

/** Non-null when a failed turn is a provider rate-limit / quota / overload
 *  stop the server can wait out and auto-resume, rather than a hard failure. */
export const providerLimitOf = (ev: OcEvent): RateLimitRetryHint | undefined => {
  if (ev.type !== "session.error") return undefined;
  return classifyProviderLimit(ev.properties?.error) ?? undefined;
};

// ------------------------------------------------ semantic observation ingestion

export type ObservationChannel = "sse" | "pull";

export interface ObservationBinding {
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
  reconciliationOrdinal: number;
}

export interface NormalizeOcObservationInput {
  data: unknown;
  channel: ObservationChannel;
  observed: ObservationBinding;
  current: ObservationBinding;
  state?: TranslateState;
  checkpoint?: ObservationCheckpoint;
  cursorAfter?: string;
}

export interface NormalizedOcObservation {
  channel: ObservationChannel;
  entityKey: string;
  identity: ObservationIdentity;
  reconciliationOrdinal: number;
  events: RuntimeEvent[];
  checkpoint?: {
    stateRank?: number;
    value: JsonObject;
  };
  cursorAfter?: string;
  uncertainty?: {
    code: "divergent-content" | "terminal-payload-changed";
    message: string;
  };
}

/** Multi-event translations use stable per-event revisions so live SSE and
 * pull reconstruction can claim the same canonical facts independently. The
 * checkpoint/cursor belongs to the final member, after the whole batch. */
export const splitNormalizedObservation = (
  observation: NormalizedOcObservation,
): NormalizedOcObservation[] => {
  if (observation.events.length <= 1) return [observation];
  const {
    events,
    checkpoint,
    cursorAfter,
    uncertainty,
    ...shared
  } = observation;
  return events.map((event, index) => {
    const final = index === events.length - 1;
    return {
      ...shared,
      identity: {
        ...observation.identity,
        revision: `${observation.identity.revision}#${index}`,
      },
      events: [event],
      ...(final && checkpoint ? { checkpoint } : {}),
      ...(final && cursorAfter ? { cursorAfter } : {}),
      ...(final && uncertainty ? { uncertainty } : {}),
    };
  });
};

export type OcObservationNormalization =
  | { kind: "accepted"; observation: NormalizedOcObservation }
  | { kind: "stale" }
  | {
      kind: "suppressed";
      code: "binding-missing" | "unidentified-recovery";
      message: string;
    };

const sameLocation = (left: RuntimeLocation, right: RuntimeLocation): boolean =>
  left.directory === right.directory
  && (left.workspace ?? "") === (right.workspace ?? "");

/** Fences are evaluated before event parsing or translation mutates state. */
export const isCurrentObservation = (
  observed: ObservationBinding,
  current: ObservationBinding,
): boolean =>
  observed.authorityId === current.authorityId
  && observed.generation === current.generation
  && observed.backendSessionId === current.backendSessionId
  && observed.reconciliationOrdinal === current.reconciliationOrdinal
  && sameLocation(observed.location, current.location);

export const isCurrentSnapshot = (
  snapshot: RuntimeSnapshot,
  current: ObservationBinding,
): boolean =>
  snapshot.authorityId === current.authorityId
  && snapshot.generation === current.generation
  && snapshot.backendSessionId === current.backendSessionId
  && snapshot.reconciliationOrdinal === current.reconciliationOrdinal
  && sameLocation(snapshot.location, current.location);

/**
 * Absence is usable only with a complete domain and a comparable, newer
 * watermark. Opaque/unversioned watermarks deliberately require a comparator.
 */
export const snapshotAbsenceIsAuthoritative = (
  snapshot: RuntimeSnapshot,
  domain: "events" | "permissions" | "questions",
  priorWatermark: string | undefined,
  compareWatermarks?: (next: string, prior: string) => number,
): boolean => {
  if (snapshot.completeness[domain] !== "complete") return false;
  const nextWatermark = snapshot.state.watermark;
  if (!nextWatermark || !priorWatermark || !compareWatermarks) return false;
  return compareWatermarks(nextWatermark, priorWatermark) > 0;
};

const valueRevision = (value: unknown): string | undefined => {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
};

export interface ComparableRuntimeRevision {
  watermark: string;
  comparison: {
    domain: string;
    order: number;
  };
}

const orderedRevisionValue = (
  value: unknown,
): { watermark: string; order: number } | undefined => {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { watermark: String(value), order: value };
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric)
    ? { watermark: value, order: numeric }
    : undefined;
};

/** Legacy status revisions are comparable only inside the same explicitly
 * named field. Opaque or prefixed IDs are identity, not an ordering proof. */
export const comparableStatusRevision = (
  ...values: Array<Record<string, unknown> | undefined>
): ComparableRuntimeRevision | undefined => {
  for (const value of values) {
    if (!value) continue;
    for (const key of ["revision", "version", "seq", "sequence", "updatedAt"]) {
      const ordered = orderedRevisionValue(value[key]);
      if (!ordered) continue;
      return {
        watermark: ordered.watermark,
        comparison: {
          domain: `legacy-status:${key}`,
          order: ordered.order,
        },
      };
    }
  }
  return undefined;
};

const explicitRevision = (...values: Array<Record<string, unknown> | undefined>): string | undefined => {
  for (const value of values) {
    if (!value) continue;
    for (const key of ["revision", "version", "seq", "sequence"]) {
      const revision = valueRevision(value[key]);
      if (revision) return revision;
    }
    const durable = asRecord(value.durable);
    if (durable) {
      const version = valueRevision(durable.version);
      const seq = valueRevision(durable.seq);
      if (version || seq) return `durable:${version ?? "?"}:${seq ?? "?"}`;
    }
  }
  return undefined;
};

interface SemanticIdentity {
  artifactKind: ObservationArtifactKind;
  entityId: string;
  revision: string;
  stateRank?: number;
  checkpoint?: JsonObject;
}

const statusValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  return typeof asRecord(value)?.type === "string"
    ? String(asRecord(value)?.type)
    : "unknown";
};

const semanticIdentityOf = (
  ev: OcEvent,
  state?: TranslateState,
): SemanticIdentity | undefined => {
  const properties = ev.properties ?? {};
  const info = asRecord(properties.info);
  const part = asRecord(properties.part);
  const directRevision = explicitRevision(
    ev as unknown as Record<string, unknown>,
    properties,
    info,
    part,
  );

  if (ev.type === "message.updated") {
    if (typeof info?.id !== "string" || !info.id) return undefined;
    const completed = asRecord(info.time)?.completed;
    const revision = directRevision
      ?? (typeof completed === "number" ? `completed:${completed}` : "snapshot");
    return {
      artifactKind: "message",
      entityId: info.id,
      revision,
      checkpoint: {
        role: typeof info.role === "string" ? info.role : "unknown",
        completed: typeof completed === "number",
      },
    };
  }

  if (ev.type === "message.part.updated") {
    if (typeof part?.id !== "string" || !part.id) return undefined;
    const type = typeof part.type === "string" ? part.type : "unknown";
    if (type === "tool") {
      const toolState = asRecord(part.state);
      const status = typeof toolState?.status === "string" ? toolState.status : "unknown";
      const ranks: Record<string, number> = {
        pending: 0,
        running: 1,
        completed: 2,
        error: 2,
      };
      const callId = typeof part.callID === "string" && part.callID ? part.callID : part.id;
      return {
        artifactKind: "tool",
        entityId: callId,
        revision: directRevision ?? `state:${status}`,
        ...(ranks[status] !== undefined ? { stateRank: ranks[status] } : {}),
        checkpoint: {
          status,
          tool: typeof part.tool === "string" ? part.tool : "tool",
          input: asJsonObject(toolState?.input),
          ...(typeof toolState?.output === "string" ? { output: toolState.output } : {}),
          ...(typeof toolState?.error === "string" ? { error: toolState.error } : {}),
        },
      };
    }
    const time = asRecord(part.time);
    const complete = typeof time?.end === "number";
    const text = typeof part.text === "string" ? part.text : "";
    return {
      artifactKind: "part",
      entityId: part.id,
      revision: directRevision
        ?? (complete ? `complete:${String(time?.end)}` : "snapshot"),
      stateRank: complete ? 2 : 1,
      checkpoint: { type, text, complete },
    };
  }

  if (ev.type === "message.part.delta") {
    const partId = properties.partID;
    if (typeof partId !== "string" || !partId || !directRevision) return undefined;
    return {
      artifactKind: "part",
      entityId: partId,
      revision: directRevision,
    };
  }

  if (ev.type === "permission.asked" || ev.type === "permission.updated") {
    const nested = asRecord(properties.permission);
    const requestId =
      typeof properties.id === "string" ? properties.id
        : typeof properties.permissionID === "string" ? properties.permissionID
          : typeof nested?.id === "string" ? nested.id
            : "";
    if (!requestId) return undefined;
    return {
      artifactKind: "permission",
      entityId: requestId,
      revision: directRevision ?? "pending",
      stateRank: 1,
      checkpoint: { pending: true },
    };
  }

  if (ev.type === "question.asked") {
    const requestId =
      typeof properties.id === "string" ? properties.id
        : typeof properties.requestID === "string" ? properties.requestID
          : "";
    if (!requestId) return undefined;
    return {
      artifactKind: "question",
      entityId: requestId,
      revision: directRevision ?? "pending",
      stateRank: 1,
      checkpoint: { pending: true },
    };
  }

  if (ev.type === "session.status" || ev.type === "session.idle" || ev.type === "session.error") {
    const sessionId = backendSessionId(ev);
    if (!sessionId) return undefined;
    const statusRecord = asRecord(properties.status);
    const errorRecord = asRecord(properties.error);
    const rawStatus = ev.type === "session.idle"
      ? "idle"
      : ev.type === "session.error"
        ? "failed"
        : statusValue(properties.status);
    const status = rawStatus === "busy" || rawStatus === "running"
      ? "running"
      : rawStatus;
    const comparable = comparableStatusRevision(
      properties,
      statusRecord,
      errorRecord,
    );
    const terminal =
      status === "idle" || status === "failed" || status === "interrupted";
    const candidateCompletion = state?.latestAssistantCompletion;
    const assistantCompletion =
      status === "idle"
      && !comparable
      && !directRevision
      && state?.admittedTurnId
      && candidateCompletion?.turnId === state.admittedTurnId
        ? candidateCompletion
        : undefined;
    const assistantComparison = assistantCompletion
      ? {
          watermark: String(assistantCompletion.order),
          comparison: {
            domain: "legacy-history:assistant-completed",
            order: assistantCompletion.order,
          },
        }
      : undefined;
    const terminalComparison = comparable ?? assistantComparison;
    return {
      artifactKind: "status",
      entityId: sessionId,
      revision: comparable
        ? `${comparable.comparison.domain}:${comparable.comparison.order}`
        : directRevision
          ?? (assistantComparison
            ? `${assistantComparison.comparison.domain}:${assistantComparison.comparison.order}`
            : `state:${status}`),
      ...(!terminal || terminalComparison
        ? {
            checkpoint: {
              state: status,
              ...(terminalComparison ? {
                watermark: terminalComparison.watermark,
                comparison: terminalComparison.comparison,
              } : {}),
            },
          }
        : {}),
    };
  }

  if (ev.type === "session.updated" || ev.type === "session.compacted") {
    const sessionId = backendSessionId(ev);
    if (!sessionId) return undefined;
    const title = typeof info?.title === "string" ? info.title.trim() : "";
    return {
      artifactKind: "turn",
      entityId: sessionId,
      // The title is a distinct, durable update, so it must not be
      // deduplicated against the initial placeholder snapshot that precedes
      // it. Direct revisions are unusable here: session snapshots embed the
      // OpenCode version (`info.version`, constant across every update), and
      // `directRevision` would fold every title change into the first
      // placeholder observation, dropping the semantic title forever. The
      // title (or the compaction marker) always identifies the observation.
      revision: ev.type === "session.compacted" ? "compacted" : `title:${title}`,
      checkpoint: { type: ev.type },
    };
  }

  return undefined;
};

const checkpointText = (
  checkpoint: ObservationCheckpoint | undefined,
): { type: "text" | "reasoning"; text: string; complete: boolean } | undefined => {
  const type = checkpoint?.value.type;
  const text = checkpoint?.value.text;
  if ((type !== "text" && type !== "reasoning") || typeof text !== "string") return undefined;
  return {
    type,
    text,
    complete: checkpoint?.value.complete === true,
  };
};

const prepareStateFromCheckpoint = (
  state: TranslateState,
  ev: OcEvent,
  checkpoint: ObservationCheckpoint | undefined,
): OcObservationNormalization | undefined => {
  const part = asRecord(ev.properties?.part);
  if (ev.type !== "message.part.updated" || typeof part?.id !== "string") return undefined;
  const prior = checkpointText(checkpoint);
  if (!prior) return undefined;
  const nextText = typeof part.text === "string" ? part.text : "";
  if (nextText && !nextText.startsWith(prior.text)) {
    return {
      kind: "suppressed",
      code: "unidentified-recovery",
      message: "recovered part diverges from its durable full-value checkpoint",
    };
  }
  state.partKind.set(part.id, prior.type);
  const values = prior.type === "reasoning" ? state.partReasoning : state.partText;
  values.set(part.id, prior.text);
  if (prior.complete) state.emittedAssistant.add(part.id);
  return undefined;
};

const terminalPayloadChanged = (
  identity: SemanticIdentity,
  checkpoint: ObservationCheckpoint | undefined,
): boolean =>
  identity.artifactKind === "tool"
  && identity.stateRank === 2
  && checkpoint?.stateRank === 2
  && JSON.stringify(identity.checkpoint ?? {}) !== JSON.stringify(checkpoint.value);

/**
 * Normalize either an SSE envelope or a pull/history reconstruction. Channel
 * is intentionally absent from entity identity, so both paths claim the same
 * durable entity/revision.
 */
export const normalizeOcObservation = (
  input: NormalizeOcObservationInput,
): OcObservationNormalization => {
  if (!isCurrentObservation(input.observed, input.current)) return { kind: "stale" };
  const ev = asOcEvent(input.data);
  if (!ev) {
    return {
      kind: "suppressed",
      code: "unidentified-recovery",
      message: "observation is not a recognized OpenCode event",
    };
  }
  const eventSessionId = backendSessionId(ev);
  if (eventSessionId && eventSessionId !== input.observed.backendSessionId) {
    return {
      kind: "suppressed",
      code: "binding-missing",
      message: "observation belongs to a different backend session",
    };
  }
  const state = input.state ?? createTranslateState();
  const semantic = semanticIdentityOf(ev, state);
  if (!semantic) {
    return {
      kind: "suppressed",
      code: "unidentified-recovery",
      message: "observation has no stable semantic entity and revision",
    };
  }

  const prepared = prepareStateFromCheckpoint(state, ev, input.checkpoint);
  const divergent = prepared?.kind === "suppressed";
  const terminalChanged = terminalPayloadChanged(semantic, input.checkpoint);
  let events: RuntimeEvent[] = [];
  if (!divergent && !terminalChanged) {
    const part = asRecord(ev.properties?.part);
    const messageId = typeof part?.messageID === "string" ? part.messageID : "";
    const explicitlyUser = ev.properties?.role === "user";
    if (!explicitlyUser && (!messageId || !state.userMessageIds.has(messageId))) {
      events = translateOcEvent(ev, state);
    } else if (ev.type === "message.updated") {
      translateOcEvent(ev, state);
    }
  }

  const identity: ObservationIdentity = {
    authorityId: input.observed.authorityId,
    generation: input.observed.generation,
    location: input.observed.location,
    backendSessionId: input.observed.backendSessionId,
    artifactKind: semantic.artifactKind,
    entityId: semantic.entityId,
    revision: divergent || terminalChanged
      ? `${semantic.revision}:uncertainty`
      : semantic.revision,
  };
  return {
    kind: "accepted",
    observation: {
      channel: input.channel,
      entityKey: semantic.entityId,
      identity,
      reconciliationOrdinal: input.observed.reconciliationOrdinal,
      events,
      ...(!divergent && !terminalChanged && semantic.checkpoint
        ? {
            checkpoint: {
              ...(semantic.stateRank !== undefined ? { stateRank: semantic.stateRank } : {}),
              value: semantic.checkpoint,
            },
          }
        : {}),
      ...(input.cursorAfter ? { cursorAfter: input.cursorAfter } : {}),
      ...(divergent
        ? {
            uncertainty: {
              code: "divergent-content" as const,
              message: "recovered content diverges from the durable checkpoint",
            },
          }
        : terminalChanged
          ? {
              uncertainty: {
                code: "terminal-payload-changed" as const,
                message: "tool payload changed at an already observed terminal rank",
              },
            }
          : {}),
    },
  };
};

const runtimeEventInput = (event: RuntimeEvent): CanonicalEventInput => {
  const { type, ...data } = event;
  return {
    type,
    data: data as unknown as JsonObject,
    ...(type === "permission/requested"
      || type === "question/asked"
      || type === "turn/started"
      || type === "turn/stopped"
      || type === "usage/recorded"
      || type === "session/compacted"
      || type === "compaction/part-recorded"
      ? { ignorable: true }
      : {}),
    producerPlugin: "backend-opencode",
  };
};

export interface IngestNormalizedObservationInput {
  store: Pick<SessionStore, "ingestObservation">;
  sessionId: string;
  observation: NormalizedOcObservation;
}

/** Claim, append the complete canonical batch, checkpoint, and cursor through
 * SessionStore's single ingestion transaction. */
export const ingestNormalizedObservation = (
  input: IngestNormalizedObservationInput,
): Promise<ObservationIngestionResult> => {
  const observation = input.observation;
  const events = observation.events.map(runtimeEventInput);
  if (observation.uncertainty) {
    events.push({
      type: "reconciliation/uncertainty-recorded",
      data: {
        entityKey: observation.entityKey,
        code: observation.uncertainty.code,
        message: observation.uncertainty.message,
      },
      ignorable: true,
      producerPlugin: "backend-opencode",
    });
  }
  return input.store.ingestObservation({
    sessionId: input.sessionId,
    identity: observation.identity,
    reconciliationOrdinal: observation.reconciliationOrdinal,
    events,
    ...(observation.checkpoint ? { checkpoint: observation.checkpoint } : {}),
    ...(observation.cursorAfter
      ? {
          cursor: {
            key: {
              authorityId: observation.identity.authorityId,
              location: observation.identity.location,
              backendSessionId: observation.identity.backendSessionId,
              channel: observation.channel,
            },
            after: observation.cursorAfter,
          },
        }
      : {}),
  });
};

export interface NormalizeAndIngestOcObservationInput
  extends Omit<NormalizeOcObservationInput, "checkpoint"> {
  store: Pick<SessionStore, "ingestObservation" | "observationCheckpoint">;
  sessionId: string;
}

export type OcObservationIngestion =
  | OcObservationNormalization
  | { kind: "ingested"; result: ObservationIngestionResult; observation: NormalizedOcObservation };

export const normalizeAndIngestOcObservation = async (
  input: NormalizeAndIngestOcObservationInput,
): Promise<OcObservationIngestion> => {
  if (!isCurrentObservation(input.observed, input.current)) return { kind: "stale" };
  const ev = asOcEvent(input.data);
  const state = input.state ?? createTranslateState();
  const semantic = ev ? semanticIdentityOf(ev, state) : undefined;
  const checkpoint = semantic
    ? await input.store.observationCheckpoint({
        authorityId: input.observed.authorityId,
        location: input.observed.location,
        backendSessionId: input.observed.backendSessionId,
        artifactKind: semantic.artifactKind,
        entityId: semantic.entityId,
      })
    : undefined;
  const normalized = normalizeOcObservation({ ...input, state, checkpoint });
  if (normalized.kind !== "accepted") return normalized;
  const result = await ingestNormalizedObservation({
    store: input.store,
    sessionId: input.sessionId,
    observation: normalized.observation,
  });
  return { kind: "ingested", result, observation: normalized.observation };
};
