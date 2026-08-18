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
  emittedAssistant: Set<string>;
  emittedUsage: Set<string>;
  lastTokens?: TokenUsage;
  lastCost?: number;
}

export const createTranslateState = (): TranslateState => ({
  userMessageIds: new Set(),
  toolCalls: new Set(),
  partText: new Map(),
  partReasoning: new Map(),
  emittedAssistant: new Set(),
  emittedUsage: new Set(),
});

export const translateOcEvent = (ev: OcEvent, state: TranslateState): RuntimeEvent[] => {
  const out: RuntimeEvent[] = [];
  const p = ev.properties ?? {};
  const type = ev.type ?? "";

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
    const field = typeof p.field === "string" ? p.field : "text";
    const messageID = typeof p.messageID === "string" ? p.messageID : "";
    if (messageID && state.userMessageIds.has(messageID)) return out;
    if (!delta) return out;
    if (field === "reasoning") {
      state.partReasoning.set(partId, (state.partReasoning.get(partId) ?? "") + delta);
      out.push({ type: "assistant/reasoning-chunk", partId, text: delta });
    } else {
      state.partText.set(partId, (state.partText.get(partId) ?? "") + delta);
      out.push({ type: "assistant/chunk", partId, text: delta });
    }
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

    if (partType === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      if (delta) {
        state.partText.set(partId, (state.partText.get(partId) ?? "") + delta);
        out.push({ type: "assistant/chunk", partId, text: delta });
      } else if (text) {
        const prev = state.partText.get(partId) ?? "";
        if (text.startsWith(prev) && text.length > prev.length) {
          const chunk = text.slice(prev.length);
          state.partText.set(partId, text);
          out.push({ type: "assistant/chunk", partId, text: chunk });
        } else {
          state.partText.set(partId, text);
        }
      }
      const time = asRecord(part.time);
      if (time && typeof time.end === "number" && !state.emittedAssistant.has(partId)) {
        state.emittedAssistant.add(partId);
        out.push({
          type: "assistant/message",
          partId,
          text: state.partText.get(partId) ?? text,
          tokens: state.lastTokens,
          cost: state.lastCost,
        });
      }
      return out;
    }

    if (partType === "reasoning") {
      const text = typeof part.text === "string" ? part.text : "";
      if (delta) {
        state.partReasoning.set(partId, (state.partReasoning.get(partId) ?? "") + delta);
        out.push({ type: "assistant/reasoning-chunk", partId, text: delta });
      } else if (text) {
        const prev = state.partReasoning.get(partId) ?? "";
        if (text.startsWith(prev) && text.length > prev.length) {
          out.push({ type: "assistant/reasoning-chunk", partId, text: text.slice(prev.length) });
        }
        state.partReasoning.set(partId, text);
      }
      return out;
    }

    if (partType === "tool") {
      const callId = typeof part.callID === "string" ? part.callID : partId;
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      const st = asRecord(part.state);
      const status = typeof st?.status === "string" ? st.status : "";
      const input = asJsonObject(st?.input);
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

export const flushAssistantOnIdle = (state: TranslateState): RuntimeEvent[] => {
  const out: RuntimeEvent[] = [];
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
