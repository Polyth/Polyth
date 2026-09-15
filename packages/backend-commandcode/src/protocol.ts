import type { JsonObject, ModelRef, RuntimeEvent, TokenUsage } from "@polyth/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const asJsonObject = (value: unknown): JsonObject => (asRecord(value) as JsonObject | undefined) ?? {};

const stringValue = (...values: unknown[]): string | undefined => {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
};

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const inputUsage = (value: unknown): number | undefined => {
  const row = asRecord(value);
  if (!row) return undefined;
  return numberValue(row.input) ?? numberValue(row.inputTokens) ?? numberValue(row.input_tokens);
};

const usage = (value: unknown): TokenUsage | undefined => {
  const row = asRecord(value);
  if (!row) return undefined;
  const input = inputUsage(row) ?? 0;
  const output = numberValue(row.output) ?? numberValue(row.outputTokens) ?? numberValue(row.output_tokens) ?? 0;
  const reasoning = numberValue(row.reasoning) ?? numberValue(row.reasoningTokens) ?? numberValue(row.reasoning_tokens);
  const cacheRead = numberValue(row.cacheRead) ?? numberValue(row.cacheReadTokens) ?? numberValue(row.cache_read_tokens);
  const cacheWrite = numberValue(row.cacheWrite) ?? numberValue(row.cacheWriteTokens) ?? numberValue(row.cache_write_tokens);
  if (!input && !output && reasoning === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    input,
    output,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
};

const modelRef = (value: unknown): ModelRef | undefined => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) return undefined;
  const slash = id.indexOf("/");
  return {
    providerID: slash > 0 ? id.slice(0, slash).toLowerCase() : "command-code",
    modelID: id,
  };
};

const textFromMessage = (value: unknown): string => {
  const row = asRecord(value);
  if (!row) return "";
  if (typeof row.text === "string") return row.text;
  if (typeof row.content === "string") return row.content;
  if (!Array.isArray(row.content)) return "";
  return row.content.flatMap((part) => {
    const block = asRecord(part);
    return block && typeof block.text === "string" ? [block.text] : [];
  }).join("");
};

const errorText = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  const row = asRecord(value);
  return stringValue(row?.message, row?.error)?.trim();
};

const safeDiagnostic = (value: unknown): string | undefined => {
  const text = errorText(value);
  if (!text) return undefined;
  return text
    .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
};

export interface CommandCodeTranslateState {
  operationId: string;
  model?: ModelRef;
  activeModel?: ModelRef;
  turnStarted: boolean;
  messageIndex: number;
  assistantText: string;
  assistantFinalized: boolean;
  usageFrames: number;
  toolInputs: Map<string, JsonObject>;
  toolNames: Map<string, string>;
  taskRevision: number;
  lastTaskKey: string;
  subagents: Map<string, { sessionId: string; label: string; status: string; currentTask?: string }>;
  subagentRevision: number;
  runError?: string;
  interrupted: boolean;
}

export const createCommandCodeTranslateState = (
  operationId: string,
  model?: ModelRef,
): CommandCodeTranslateState => ({
  operationId,
  model,
  activeModel: model,
  turnStarted: false,
  messageIndex: 0,
  assistantText: "",
  assistantFinalized: false,
  usageFrames: 0,
  toolInputs: new Map(),
  toolNames: new Map(),
  taskRevision: 0,
  lastTaskKey: "",
  subagents: new Map(),
  subagentRevision: 0,
  interrupted: false,
});

const startAssistantMessage = (state: CommandCodeTranslateState): void => {
  state.messageIndex += 1;
  state.assistantText = "";
  state.assistantFinalized = false;
};

const ensureAssistantMessage = (state: CommandCodeTranslateState): void => {
  if (state.messageIndex === 0) startAssistantMessage(state);
};

const assistantPartId = (state: CommandCodeTranslateState): string => {
  ensureAssistantMessage(state);
  return state.messageIndex === 1
    ? `${state.operationId}:answer`
    : `${state.operationId}:answer:${state.messageIndex}`;
};

const taskSnapshot = (
  state: CommandCodeTranslateState,
  input: JsonObject,
): RuntimeEvent | undefined => {
  if (!Array.isArray(input.todos)) return undefined;
  const items = input.todos.flatMap((value, index) => {
    const todo = asRecord(value);
    const content = typeof todo?.content === "string" ? todo.content.trim() : "";
    if (!content) return [];
    const nativeStatus = typeof todo?.status === "string" ? todo.status : "pending";
    const status = nativeStatus === "in_progress"
      ? "active" as const
      : nativeStatus === "completed"
        ? "done" as const
        : "pending" as const;
    const nativeId = typeof todo?.id === "string" && todo.id.trim() ? todo.id.trim() : undefined;
    return [{
      id: nativeId ?? `commandcode-todo:${index}:${content}`,
      text: content,
      status,
    }];
  });
  const key = JSON.stringify(items);
  if (key === state.lastTaskKey) return undefined;
  state.lastTaskKey = key;
  return { type: "task/snapshot", listId: "todo", revision: ++state.taskRevision, items };
};

/** Command Code's ask_user_question schema is intentionally normalized at the
 * adapter boundary so its `header`/`multiSelect` names never leak into web UI. */
const structuredQuestions = (input: JsonObject): JsonObject[] => {
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((value, index) => {
    const raw = asRecord(value);
    const prompt = stringValue(raw?.question)?.trim();
    if (!raw || !prompt) return [];
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option) => {
          const row = asRecord(option);
          const label = stringValue(row?.label)?.trim();
          if (!label) return [];
          return [{
            value: label,
            label,
            ...(stringValue(row?.description)?.trim()
              ? { description: stringValue(row?.description)!.trim() }
              : {}),
          } satisfies JsonObject];
        })
      : [];
    return [{
      id: `q${index + 1}`,
      ...(stringValue(raw.header)?.trim() ? { title: stringValue(raw.header)!.trim() } : {}),
      prompt,
      type: raw.multiSelect === true ? "multi" : options.length ? "single" : "text",
      ...(options.length ? { options } : {}),
      required: true,
      // Command Code always allows a free-text reply in addition to options.
      ...(options.length ? { allowOther: true } : {}),
    } satisfies JsonObject];
  });
};

const subagentEvent = (
  state: CommandCodeTranslateState,
  event: Record<string, unknown>,
  status: string,
): RuntimeEvent | undefined => {
  const id = stringValue(event.toolCallId, event.tool_call_id, event.id);
  if (!id) return undefined;
  const label = stringValue(event.subagentType, event.subagent_type, event.agent) ?? "Command Code agent";
  const currentTask = stringValue(event.toolName, event.tool_name);
  state.subagents.set(id, {
    sessionId: id,
    label,
    status,
    ...(currentTask ? { currentTask } : {}),
  });
  return {
    type: "subagent/snapshot",
    revision: ++state.subagentRevision,
    agents: [...state.subagents.values()],
  };
};

const toolIdentity = (
  state: CommandCodeTranslateState,
  event: Record<string, unknown>,
): { callId: string; tool: string } => {
  const callId = stringValue(event.toolCallId, event.tool_call_id, event.id) ?? `${state.operationId}:tool`;
  const tool = stringValue(event.toolName, event.tool_name, event.name) ?? state.toolNames.get(callId) ?? "tool";
  return { callId, tool };
};

/** Translate one official headless NDJSON record. Unknown future events are ignored.
 * Native thinking frames are intentionally excluded from canonical Polyth history. */
export function translateCommandCodeRecord(
  record: unknown,
  state: CommandCodeTranslateState,
): RuntimeEvent[] {
  const outer = asRecord(record);
  if (!outer) return [];
  if (outer.type === "result") {
    const tokens = usage(outer.usage);
    const finalText = stringValue(outer.finalText, outer.final_text);
    const out: RuntimeEvent[] = [];
    // Chunks are provisional. A missing message_end on the final native round
    // must not leave canonical history without a finalized assistant message.
    if (finalText && !state.assistantFinalized) {
      state.assistantText = finalText;
      state.assistantFinalized = true;
      out.push({
        type: "assistant/message",
        partId: assistantPartId(state),
        text: finalText,
        ...(tokens ? { tokens } : {}),
      });
    }
    // model_request_end is the preferred per-round additive accounting path.
    // The documented final result usage is a fallback only when no such frame
    // was observed, so a normal tool loop cannot double-count lifetime usage.
    const fallbackModel = state.activeModel ?? state.model;
    if (tokens && fallbackModel && state.usageFrames === 0) {
      out.push({ type: "usage/recorded", model: fallbackModel, tokens });
      state.usageFrames += 1;
    }
    return out;
  }
  if (outer.type !== "event") return [];
  const event = asRecord(outer.event);
  if (!event || typeof event.type !== "string") return [];

  switch (event.type) {
    case "turn_start": {
      if (state.turnStarted) return [];
      state.turnStarted = true;
      return [{ type: "turn/started", turnId: state.operationId, ...(state.model ? { model: state.model } : {}) }];
    }
    case "message_start":
      startAssistantMessage(state);
      return [];
    case "model_request_start": {
      const current = modelRef(event.model);
      if (current) {
        state.activeModel = current;
        state.model ??= current;
      }
      return [];
    }
    case "text_delta": {
      const text = stringValue(event.delta, event.text);
      if (!text) return [];
      ensureAssistantMessage(state);
      state.assistantText += text;
      return [{ type: "assistant/chunk", partId: assistantPartId(state), text }];
    }
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      // Command Code may stream private model reasoning. It is provider-internal
      // telemetry, not canonical dialogue, and must never be persisted by Polyth.
      return [];
    case "message_end": {
      ensureAssistantMessage(state);
      if (state.assistantFinalized) return [];
      const text = textFromMessage(event.message) || stringValue(event.text) || state.assistantText;
      if (!text) return [];
      state.assistantText = text;
      state.assistantFinalized = true;
      return [{
        type: "assistant/message",
        partId: assistantPartId(state),
        text,
      }];
    }
    case "tool_queued": {
      const callId = stringValue(event.toolCallId, event.tool_call_id, event.id);
      const tool = stringValue(event.toolName, event.tool_name, event.name);
      const input = asJsonObject(event.input);
      if (callId) {
        state.toolInputs.set(callId, input);
        if (tool) state.toolNames.set(callId, tool);
      }
      if (tool === "ask_user_question" && callId) {
        const questions = structuredQuestions(input);
        return questions.length ? [{ type: "question/asked", requestId: callId, questions }] : [];
      }
      if (tool !== "todo_write") return [];
      const snapshot = taskSnapshot(state, input);
      return snapshot ? [snapshot] : [];
    }
    case "tool_running": {
      const { callId, tool } = toolIdentity(state, event);
      return [{ type: "tool/started", callId, tool, input: state.toolInputs.get(callId) ?? asJsonObject(event.input) }];
    }
    case "tool_completed": {
      const { callId, tool } = toolIdentity(state, event);
      const output = stringValue(event.result, event.output, event.text)
        ?? (event.result === undefined ? "" : JSON.stringify(event.result));
      return [{ type: "tool/result", callId, tool, output }];
    }
    case "tool_hook_blocked": {
      const { callId, tool } = toolIdentity(state, event);
      // Our transient Mod intentionally blocks ask_user_question after the
      // Polyth answer is captured; the block text is the successful tool result
      // delivered to the model, not an error the user should see.
      if (tool === "ask_user_question") return [];
      const error = safeDiagnostic(event.error)
        ?? safeDiagnostic(event.message)
        ?? safeDiagnostic(event.hookOutput)
        ?? "Command Code tool hook blocked the call";
      return [{ type: "tool/error", callId, tool, error }];
    }
    case "tool_errored":
    case "tool_denied": {
      const { callId, tool } = toolIdentity(state, event);
      const error = safeDiagnostic(event.error)
        ?? safeDiagnostic(event.message)
        ?? (event.type === "tool_denied" ? "Command Code denied the tool call" : "Command Code tool failed");
      return [{ type: "tool/error", callId, tool, error }];
    }
    case "session_titled": {
      const title = stringValue(event.title)?.trim();
      return title && !/^new session$|^untitled$|^command code session$/i.test(title)
        ? [{ type: "session/title-generated", title }]
        : [];
    }
    case "compaction_start":
      return [{
        type: "context/updated",
        source: "unknown",
        updatedAt: Date.now(),
        compaction: { active: true },
      }];
    case "compaction_done": {
      const now = Date.now();
      return [
        { type: "session/compacted" },
        {
          type: "context/updated",
          source: "unknown",
          updatedAt: now,
          compaction: { active: false, lastAt: now },
        },
      ];
    }
    case "subagent_start": {
      const snapshot = subagentEvent(state, event, "running");
      return snapshot ? [snapshot] : [];
    }
    case "subagent_progress": {
      const snapshot = subagentEvent(state, event, "running");
      return snapshot ? [snapshot] : [];
    }
    case "subagent_stop": {
      const snapshot = subagentEvent(state, event, "completed");
      return snapshot ? [snapshot] : [];
    }
    case "model_request_end": {
      const current = modelRef(event.model) ?? state.activeModel ?? state.model;
      if (current) {
        state.activeModel = current;
        state.model ??= current;
      }
      const tokens = usage(event.usage);
      const promptTokens = inputUsage(event.usage);
      const out: RuntimeEvent[] = [];
      // `/context` documents provider-reported last-request usage as its
      // ground truth, then adds local estimates for content appended afterward.
      // AgentEvent exposes the former but not the estimator. Report the exact
      // request input count as derived occupancy; do not invent a model limit
      // or claim that it includes the assistant/tool content added afterward.
      if (promptTokens !== undefined) {
        out.push({
          type: "context/updated",
          usedTokens: Math.max(0, promptTokens),
          source: "derived",
          updatedAt: Date.now(),
        });
      }
      if (tokens && current) {
        state.usageFrames += 1;
        out.push({ type: "usage/recorded", model: current, tokens });
      }
      return out;
    }
    case "run_error":
      state.runError = errorText(event.error) ?? stringValue(event.message)?.trim() ?? "Command Code run failed";
      return [];
    case "interrupted":
      state.interrupted = true;
      return [];
    default:
      return [];
  }
}
