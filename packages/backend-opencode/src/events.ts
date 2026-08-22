import type { JsonObject, RuntimeEvent, TokenUsage } from "@polyth/contracts";

export interface OcEvent {
  id?: string;
  type?: string;
  properties?: Record<string, unknown>;
}

export const asOcEvent = (data: unknown): OcEvent | undefined => {
  if (!data || typeof data !== "object") return undefined;
  const rec = data as Record<string, unknown>;
  const nested = rec.payload;
  const src = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : rec;
  const type = typeof src.type === "string" ? src.type : undefined;
  if (!type) return undefined;
  const properties =
    src.properties && typeof src.properties === "object"
      ? (src.properties as Record<string, unknown>)
      : {};
  const id = typeof src.id === "string" ? src.id : undefined;
  return { id, type, properties };
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

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

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
  toolCalls: Set<string>;
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
  toolCalls: new Set(),
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
        const nextStatus = status === "completed" ? "done" : status === "error" ? "failed" : "running";
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
      if ((status === "pending" || status === "running") && !state.toolCalls.has(callId)) {
        state.toolCalls.add(callId);
        out.push({ type: "tool/call", callId, tool, input });
      }
      if (status === "completed") {
        if (!state.toolCalls.has(callId)) {
          state.toolCalls.add(callId);
          out.push({ type: "tool/call", callId, tool, input });
        }
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
      if (status === "error") {
        if (!state.toolCalls.has(callId)) {
          state.toolCalls.add(callId);
          out.push({ type: "tool/call", callId, tool, input });
        }
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
      patterns: patternsOf(nested),
      metadata: nested.metadata ? asJsonObject(nested.metadata) : undefined,
      tool,
    });
    return out;
  }

  if (type === "question.asked" || type === "question.v2.asked") {
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

export const isIdleEvent = (ev: OcEvent): boolean => {
  if (ev.type === "session.idle") return true;
  if (ev.type === "session.status") {
    const status = ev.properties?.status;
    if (status === "idle") return true;
    if (status && typeof status === "object" && (status as Record<string, unknown>).type === "idle") {
      return true;
    }
  }
  return false;
};

export const errorMessageOf = (ev: OcEvent): string | undefined => {
  if (ev.type !== "session.error") return undefined;
  const err = asRecord(ev.properties?.error);
  const data = asRecord(err?.data);
  if (typeof data?.message === "string") return data.message;
  if (typeof err?.message === "string") return err.message;
  return "session error";
};
