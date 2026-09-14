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

const usage = (value: unknown): TokenUsage | undefined => {
  const row = asRecord(value);
  if (!row) return undefined;
  const input = numberValue(row.input) ?? numberValue(row.inputTokens) ?? numberValue(row.input_tokens) ?? 0;
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
    // Chunks are provisional. A missing message_end must not leave canonical
    // history without a finalized assistant message. Reuse the answer part id
    // so the final event closes the same streamed surface instead of duplicating it.
    if (finalText && !state.assistantFinalized) {
      state.assistantText = finalText;
      state.assistantFinalized = true;
      out.push({
        type: "assistant/message",
        partId: `${state.operationId}:answer`,
        text: finalText,
        ...(tokens ? { tokens } : {}),
      });
    }
    // model_request_end is the preferred per-round additive accounting path.
    // The documented final result usage is a fallback only when no such frame
    // was observed, so a normal tool loop cannot double-count lifetime usage.
    if (tokens && state.model && state.usageFrames === 0) {
      out.push({ type: "usage/recorded", model: state.model, tokens });
      state.usageFrames += 1;
    }
    return out;
  }
  if (outer.type !== "event") return [];
  const event = asRecord(outer.event);
  if (!event || typeof event.type !== "string") return [];

  switch (event.type) {
    case "turn_start":
      return [{ type: "turn/started", turnId: state.operationId, ...(state.model ? { model: state.model } : {}) }];
    case "model_request_start": {
      state.model ??= modelRef(event.model);
      return [];
    }
    case "text_delta": {
      const text = stringValue(event.delta, event.text);
      if (!text) return [];
      state.assistantText += text;
      return [{ type: "assistant/chunk", partId: `${state.operationId}:answer`, text }];
    }
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      // Command Code may stream private model reasoning. It is provider-internal
      // telemetry, not canonical dialogue, and must never be persisted by Polyth.
      return [];
    case "message_end": {
      const text = textFromMessage(event.message) || stringValue(event.text) || state.assistantText;
      if (!text) return [];
      state.assistantText = text;
      state.assistantFinalized = true;
      return [{
        type: "assistant/message",
        partId: `${state.operationId}:answer`,
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
      const output = stringValue(event.result, event.output, event.text) ?? JSON.stringify(event.result ?? "");
      return [{ type: "tool/result", callId, tool, output }];
    }
    case "tool_errored":
    case "tool_denied":
    case "tool_hook_blocked": {
      const { callId, tool } = toolIdentity(state, event);
      const error = safeDiagnostic(event.error)
        ?? safeDiagnostic(event.message)
        ?? safeDiagnostic(event.hookOutput)
        ?? (event.type === "tool_denied" ? "Command Code denied the tool call" : "Command Code tool failed");
      return [{ type: "tool/error", callId, tool, error }];
    }
    case "session_titled": {
      const title = stringValue(event.title)?.trim();
      return title && !/^new session$|^untitled$|^command code session$/i.test(title)
        ? [{ type: "session/title-generated", title }]
        : [];
    }
    case "compaction_done":
      return [{ type: "session/compacted" }];
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
      state.model ??= modelRef(event.model);
      const tokens = usage(event.usage);
      if (!tokens || !state.model) return [];
      state.usageFrames += 1;
      return [{ type: "usage/recorded", model: state.model, tokens }];
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
