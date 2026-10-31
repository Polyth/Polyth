import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  AgentRuntime,
  HarnessContext,
  JsonObject,
  ModelDescriptor,
  ModelRef,
  MutationOutcome,
  RateLimitRetryHint,
  RuntimeCapabilities,
  RuntimeCommandDescriptor,
  RuntimeErrorCode,
  RuntimeEvent,
  RuntimeSnapshot,
  UsageRecordedData,
} from "@polyth/contracts";
import {
  attachmentModality,
  composeTurnPrompt,
  contextWindowTelemetry,
  isPlaceholderTitle,
  unsupportedAttachmentMessage,
} from "@polyth/harness-runtime";
import type { PiRpc, PiRpcEvent, PiRpcModel, PiRpcSessionStats, PiRpcState } from "./rpc.ts";
import { isExplicitSessionTitle } from "./title.ts";

export const PI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: false,
  questions: false,
  compaction: false,
  subagents: false,
  // Pi has no native MCP client. Polyth projects the same scoped package tools
  // through a private CLI extension and FD relay.
  mcp: true,
  steering: false,
  resume: true,
  // Every assistant `message_end` carries the provider-reported usage of that
  // one LLM call, priced by Pi's model catalog.
  usage: true,
  cost: true,
  fork: false,
  // Pi RPC exposes a session display name that a user, an extension or a
  // client can set, but the native agent does not derive one from the prompt.
  // The adapter adds a best-effort generated name; keeping "emulated" lets the
  // canonical layer publish its prompt-derived fallback immediately and lets
  // the generated (or explicit) native name refine it later.
  title: "emulated",
  attachments: {
    modalities: {
      image: "native",
      // Pi RPC carries image content blocks only, so a text file is delivered
      // by the server's guarded prompt projection instead of a native block.
      file: "emulated",
      url: "unsupported",
      pdf: "unsupported",
      audio: "unsupported",
    },
  },
  commands: { discovery: "native", invoke: "raw-native-input" },
  contextOccupancy: "native",
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const asJsonObject = (value: unknown): JsonObject =>
  (asRecord(value) as JsonObject | undefined) ?? {};

const modelDescriptor = (value: PiRpcModel): ModelDescriptor | undefined => {
  const providerID = typeof value.provider === "string" && value.provider.trim() ? value.provider : undefined;
  const modelID = typeof value.id === "string" && value.id.trim() ? value.id : undefined;
  if (!providerID || !modelID) return undefined;
  return {
    providerID,
    modelID,
    name: typeof value.name === "string" && value.name.trim() ? value.name : modelID,
    connected: true,
    ...(typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow)
      ? { context: value.contextWindow }
      : {}),
  };
};

/** The native model Pi reports in `get_state`, as a canonical ref. */
const modelRefFromState = (state: PiRpcState | undefined): ModelRef | undefined => {
  const providerID = state?.model?.provider?.trim();
  const modelID = state?.model?.id?.trim();
  return providerID && modelID ? { providerID, modelID } : undefined;
};

const textBlocks = (message: unknown): Array<{ index: number; text: string }> => {
  const row = asRecord(message);
  if (!row) return [];
  if (typeof row.content === "string") return row.content ? [{ index: 0, text: row.content }] : [];
  if (!Array.isArray(row.content)) return [];
  return row.content.flatMap((part, index) => {
    const block = asRecord(part);
    return block?.type === "text" && typeof block.text === "string" && block.text
      ? [{ index, text: block.text }]
      : [];
  });
};

const toolOutput = (value: unknown): string => {
  const row = asRecord(value);
  const content = Array.isArray(row?.content) ? row.content : [];
  return content.flatMap((part) => {
    const block = asRecord(part);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
};

const finiteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Map the per-call `usage` of a final assistant message. The final message's
 * usage covers exactly that one LLM call (unlike the cumulative streaming
 * `message_update.usage`), so the samples are additive across a turn. Pi's
 * `reasoning` is a subset of `output` and is left out so the canonical total
 * (input + output + reasoning) does not count it twice. */
const assistantUsage = (
  message: Record<string, unknown>,
  fallbackProvider: string,
  harnessId = "pi",
): Omit<UsageRecordedData, "turnId"> | undefined => {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const input = finiteCount(usage.input);
  const output = finiteCount(usage.output);
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = finiteCount(usage.cacheRead);
  const cacheWrite = finiteCount(usage.cacheWrite);
  const cost = finiteCount(asRecord(usage.cost)?.total);
  const providerID = typeof message.provider === "string" && message.provider.trim()
    ? message.provider
    : fallbackProvider || "unknown";
  const modelID = typeof message.model === "string" && message.model.trim() ? message.model : "unknown";
  return {
    model: { providerID, modelID },
    tokens: {
      input: input ?? 0,
      output: output ?? 0,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
    ...(cost !== undefined ? { cost, costSource: "derived" as const } : {}),
    harnessId,
    quality: "exact",
  };
};

type PiFailureClassification = {
  code?: RuntimeErrorCode;
  retry?: RateLimitRetryHint;
};

/** Convert only explicit provider-capacity failures into the shared retry
 * contract. Disconnects and ambiguous RPC failures must remain non-retryable:
 * they do not prove that the native turn settled. */
const classifyPiFailure = (
  error: string,
  provider?: string,
): PiFailureClassification => {
  const text = error.trim();
  const providerHint = provider ? { provider } : {};
  // Authentication, configuration and model-selection failures are actionable
  // user/account problems, not provider-capacity failures. Keep them out of
  // the automatic resume path even if a provider embeds a capacity-looking
  // phrase in the diagnostic.
  if (/(?:authenticat(?:e|ion)|unauthori[sz]ed|credential|sign[ -]?in|\bconfig(?:uration)?\b|\b(?:invalid|unknown|unsupported|unavailable)\s+model\b|\bmodel\s+(?:invalid|unknown|unavailable)\b|\bmodel\b[^\n]{0,80}\b(?:not found|not available|not supported|not enabled)\b)/i.test(text)) {
    return {};
  }
  // An account out of money or credits does not roll over by itself, even
  // when the provider sends it as a 429 (OpenAI's `insufficient_quota`).
  // Match these exact billing markers before the rate patterns below, which
  // would otherwise resend the turn forever. A bare "quota" stays ambiguous
  // (daily and per-minute quotas do roll over) and is matched after them.
  const billing = /\b402\b|insufficient[_\s-]?(?:account[_\s-]?)?funds|insufficient[_\s-]?quota|credits?[_\s-]?depleted|out of credits?|credit balance (?:is )?too low/i;
  if (billing.test(text)) {
    return {
      code: "quota-exhausted",
      retry: { scope: "quota", ...providerHint, retryable: false },
    };
  }
  // A per-window token/request allowance ("TPM (Tokens Per Minute) limit … is
  // exceeded") rolls over by itself. Match it before the overflow guard below,
  // which would otherwise read its "exceeded" as a context overflow.
  if (/\b429\b|rate[_\s-]?limit(?:[_\s-]?error)?|ratelimited|too many requests|throttl(?:e|ed|ing)|resource[_\s-]?exhausted|\b(?:tpm|rpm|tpd|rpd|tps|rps)\b|\b(?:tokens?|requests?)[_\s-]per[_\s-](?:sec(?:ond)?|min(?:ute)?|hour|day)\b/i.test(text)) {
    return {
      code: "rate-limited",
      retry: { scope: "rate", ...providerHint, retryable: true },
    };
  }
  if (/\b(?:503|529)\b|overload(?:ed)?|at capacity|temporarily unavailable/i.test(text)) {
    return {
      code: "overloaded",
      retry: { scope: "overloaded", ...providerHint, retryable: true },
    };
  }
  if (/\b402\b|quota|insufficient[_\s-]?(?:account[_\s-]?)?funds|insufficient[_\s-]?quota|credits?[_\s-]?depleted|out of credits?|quota[_\s-]?exceeded|usage[_\s-]?limit[_\s-]?exceeded|credit balance (?:is )?too low/i.test(text)) {
    return {
      code: "quota-exhausted",
      retry: { scope: "quota", ...providerHint, retryable: false },
    };
  }
  // A provider that answers "invalid request" for one call is usually refusing
  // a transient detail of that request (an interposed proxy, an account that
  // is briefly over some limit), not the conversation itself. A few bounded
  // resends recover those; the server is what bounds them (scope "request").
  // A context/payload overflow is deliberately NOT that class: repeating the
  // same bytes cannot fix it — the native leg has to compact first — so it
  // stays a non-retryable failure here.
  const overflow = /\bexceed(?:s|ed|ing)?\b|\btoo (?:large|long)\b|context[_\s-]?(?:length|window|limit)|prompt[_\s-]?(?:length|size)|maximum context/i.test(text);
  if (
    !overflow
    && (/\binvalid[_\s-]?request(?:[_\s-]?error)?\b/i.test(text) || /\b(?:400|422)\b/.test(text))
  ) {
    return { retry: { scope: "request", ...providerHint, retryable: true } };
  }
  return {};
};

const mutation = async <T>(operationId: string, action: () => Promise<T>): Promise<MutationOutcome<T>> => {
  try {
    return { kind: "confirmed", value: await action() };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "runtime-rejected") {
      return {
        kind: "rejected",
        code: "runtime-rejected",
        message: error instanceof Error ? error.message : "Pi rejected the request",
      };
    }
    return {
      kind: "unknown",
      operationId,
      message: error instanceof Error ? error.message : "Pi did not confirm the request",
    };
  }
};

export interface PiRuntimeOptions {
  /** `pi` or one of its account harnesses (`pi-<account>`). */
  harnessId?: string;
}
export function createPiRuntime(context: HarnessContext, rpc: PiRpc, options: PiRuntimeOptions = {}): AgentRuntime {
  const harnessId = options.harnessId ?? "pi";
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
  const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
  let nativeId = "";
  let sessionTitle = "";
  // The Polyth prompt fallback currently supplied for this session, if any. It
  // may already sit in the native session file from an older runtime, so it
  // must never be re-published as a semantic native title.
  let polythFallbackTitle = "";
  let createOperationId = "";
  let activeOperationId = "";
  let assistantMessageOrdinal = 0;
  let activeAssistantOrdinal = 0;
  let connected = true;
  let abortRequested = false;
  let lastStopReason = "";
  let lastError = "";
  let activeProvider = "";
  // A runtime created for a workspace (no canonical session bound at creation,
  // e.g. utility/background work) must still route its events to the canonical
  // session named by the operation it is serving. Otherwise `emit` below drops
  // every event and callers like oneShot only ever observe a timeout.
  let activeSessionId = context.sessionId ?? "";
  let order = 0;
  const streamed = new Map<number, string>();
  const streamedThinking = new Map<number, string>();

  const endpoint = {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
    continuity: "generation-only" as const,
    url: "stdio:pi",
    location: { directory: context.cwd },
    control: { kind: "owned" as const, instanceToken: rpc.authorityId },
    config: { kind: "read-only" as const },
    authentication: { kind: "none" as const },
  };

  const emit = (event: RuntimeEvent) => {
    const sessionId = activeSessionId || context.sessionId || "";
    if (!sessionId) return;
    for (const callback of listeners) callback(sessionId, event);
  };

  // A private session runs under `--no-session`: Pi keeps it in memory with
  // an id but no session file, and it ends with this process.
  const nativeIdOf = (state: PiRpcState | undefined): string | undefined =>
    state?.sessionFile ?? (context.privateSession ? state?.sessionId : undefined);

  // Pi stores a display name in the native session file. A name set through
  // `/name`, `--name`, an extension or Polyth's generated title is a semantic
  // title; a placeholder or Polyth's own prompt fallback is not.
  const adoptNativeTitle = (value: unknown): void => {
    const next = typeof value === "string" ? value.trim() : "";
    const effective = next && next === polythFallbackTitle ? "" : next;
    if (effective === sessionTitle) return;
    sessionTitle = effective;
    if (effective && !isPlaceholderTitle(effective, context.sessionId)) {
      emit({ type: "session/title-generated", title: effective });
    }
  };

  const partId = (contentIndex: number) => `${activeOperationId}:${activeAssistantOrdinal}:${contentIndex}`;

  const refreshContextTelemetry = async () => {
    try {
      const stats = await rpc.request<PiRpcSessionStats>({ type: "get_session_stats" }, 10_000);
      const usage = stats?.contextUsage;
      const usedTokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
      const limitTokens = typeof usage?.contextWindow === "number" ? usage.contextWindow : undefined;
      if (usedTokens !== undefined || limitTokens !== undefined) {
        emit({
          type: "context/updated",
          ...contextWindowTelemetry({ source: "native", usedTokens, limitTokens }),
        });
      }
    } catch {
      // Telemetry is auxiliary and must never turn a completed native turn into a failure.
    }
  };

  const settleActiveTurn = () => {
    if (!activeOperationId) return;
    const turnId = activeOperationId;
    const provider = activeProvider || undefined;
    activeOperationId = "";
    activeProvider = "";
    streamed.clear();
    streamedThinking.clear();
    order++;
    if (abortRequested || lastStopReason === "aborted") {
      emit({ type: "turn/stopped", turnId, reason: "aborted" });
    } else if (lastStopReason === "error") {
      const error = lastError || "Pi reported a native model error";
      emit({
        type: "turn/stopped",
        turnId,
        reason: "error",
        error,
        ...classifyPiFailure(error, provider),
      });
    } else {
      emit({ type: "turn/stopped", turnId, reason: "completed" });
    }
    abortRequested = false;
    lastStopReason = "";
    lastError = "";
    void refreshContextTelemetry();
    void nativeCommands().then((commands) => emit({ type: "runtime/commands-changed", commands })).catch(() => {});
  };

  const handleEvent = (event: PiRpcEvent) => {
    const type = event.type;
    if (type === "message_start") {
      const message = asRecord(event.message);
      if (message?.role === "assistant" && activeOperationId) {
        activeAssistantOrdinal = assistantMessageOrdinal++;
        streamed.clear();
        streamedThinking.clear();
      }
      return;
    }

    if (type === "message_update" && activeOperationId) {
      const delta = asRecord(event.assistantMessageEvent);
      const thinkingDelta = typeof delta?.thinking === "string"
        ? delta.thinking
        : typeof delta?.delta === "string" && delta.type === "thinking_delta"
          ? delta.delta
          : "";
      if (thinkingDelta) {
        const index = typeof delta?.contentIndex === "number" ? delta.contentIndex : 0;
        streamedThinking.set(index, `${streamedThinking.get(index) ?? ""}${thinkingDelta}`);
        emit({ type: "assistant/reasoning-chunk", partId: partId(index), text: thinkingDelta });
        return;
      }
      if (delta?.type !== "text_delta" || typeof delta.delta !== "string") return;
      const index = typeof delta.contentIndex === "number" ? delta.contentIndex : 0;
      streamed.set(index, `${streamed.get(index) ?? ""}${delta.delta}`);
      emit({ type: "assistant/chunk", partId: partId(index), text: delta.delta });
      return;
    }

    if (type === "message_end" && activeOperationId) {
      const message = asRecord(event.message);
      if (message?.role !== "assistant") return;
      const blocks = textBlocks(message);
      const content = Array.isArray(message.content) ? message.content : [];
      const explicitThinkingIndexes = new Set<number>();
      for (const [index, part] of content.entries()) {
        const block = asRecord(part);
        if (block?.type !== "thinking") continue;
        explicitThinkingIndexes.add(index);
        const reasoning = block.thinking ?? block.text;
        if (typeof reasoning === "string") {
          emit({ type: "assistant/message", partId: partId(index), text: "", reasoning });
        }
      }
      if (blocks.length) {
        for (const block of blocks) {
          emit({ type: "assistant/message", partId: partId(block.index), text: block.text });
        }
      } else {
        for (const [index, text] of [...streamed].sort(([a], [b]) => a - b)) {
          if (text) emit({ type: "assistant/message", partId: partId(index), text });
        }
      }
      for (const [index, reasoning] of [...streamedThinking].sort(([a], [b]) => a - b)) {
        if (reasoning && !explicitThinkingIndexes.has(index)) {
          emit({ type: "assistant/message", partId: partId(index), text: "", reasoning });
        }
      }
      const usage = assistantUsage(message, activeProvider, harnessId);
      if (usage) emit({ type: "usage/recorded", ...usage, turnId: activeOperationId });
      lastStopReason = typeof message.stopReason === "string" ? message.stopReason : lastStopReason;
      lastError = typeof message.errorMessage === "string" ? message.errorMessage : lastError;
      streamed.clear();
      streamedThinking.clear();
      return;
    }

    if (type === "tool_execution_start" && activeOperationId) {
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : "pi-tool";
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      emit({ type: "tool/started", callId, tool, input: asJsonObject(event.args) });
      return;
    }

    if (type === "tool_execution_end" && activeOperationId) {
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : "pi-tool";
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      if (event.isError === true) {
        emit({ type: "tool/error", callId, tool, error: toolOutput(event.result) || "Pi tool failed" });
      } else {
        emit({ type: "tool/result", callId, tool, output: toolOutput(event.result) });
      }
      return;
    }

    // Pi does not generate a semantic title by itself, but a user, an
    // extension, an explicit `/name`, or Polyth's own generated name can set
    // one. Surface that exact name so it can refine the canonical
    // prompt-derived title.
    if (type === "session_info_changed") {
      adoptNativeTitle(event.name);
      return;
    }

    // `agent_end` is deliberately not terminal: Pi may still retry, compact,
    // or consume queued continuations. `agent_settled` is the native idle proof.
    if (type === "agent_settled") settleActiveTurn();
  };

  const eventSubscription = rpc.onEvent(handleEvent);
  const closeSubscription = rpc.onClose(() => {
    connected = false;
    for (const callback of lifecycle) {
      callback({ type: "stream-disconnected", authorityId: rpc.authorityId, generation: rpc.generation });
    }
  });

  const currentState = () => rpc.request<PiRpcState>({ type: "get_state" }, 10_000);

  const models = async (): Promise<ModelDescriptor[]> => {
    const data = await rpc.request<{ models?: PiRpcModel[] }>({ type: "get_available_models" }, 15_000);
    const catalog = (Array.isArray(data?.models) ? data.models : []).flatMap((entry) => {
      const model = modelDescriptor(entry);
      return model ? [model] : [];
    });
    try {
      const state = await currentState();
      const provider = state.model?.provider;
      const modelId = state.model?.id;
      if (typeof provider === "string" && typeof modelId === "string") {
        const levels = await rpc.request<{ levels?: string[] }>({ type: "get_available_thinking_levels" }, 10_000);
        const variants = (Array.isArray(levels?.levels) ? levels.levels : []).filter((value): value is string =>
          typeof value === "string" && value.length > 0,
        );
        if (variants.length > 1) {
          return catalog.map((model) => model.providerID === provider && model.modelID === modelId
            ? { ...model, variants }
            : model);
        }
      }
    } catch {
      // The model catalog itself remains authoritative if optional variant discovery fails.
    }
    return catalog;
  };

  const nativeCommands = async (): Promise<RuntimeCommandDescriptor[]> => {
    try {
      const data = await rpc.request<{ commands?: unknown[] }>({ type: "get_commands" }, 10_000);
      return (Array.isArray(data?.commands) ? data.commands : []).flatMap((value) => {
        const command = asRecord(value);
        const name = typeof command?.name === "string" ? command.name.trim() : "";
        if (!name) return [];
        return [{
          id: `native:${harnessId}:${name}`,
          name,
          ...(typeof command?.description === "string" ? { description: command.description } : {}),
          owner: "native" as const,
          harnessId,
          invocation: "raw-native-input" as const,
          availability: "session" as const,
          acceptsArguments: true,
        }];
      });
    } catch {
      return [];
    }
  };

  const createSession: NonNullable<AgentRuntime["createSessionOperation"]> = async (canonical, operationId) => {
    if (canonical.sessionId) activeSessionId = canonical.sessionId;
    const outcome = await mutation(operationId, async () => {
      const result = await rpc.request<{ cancelled?: boolean }>({ type: "new_session" }, 30_000);
      if (result?.cancelled) {
        throw Object.assign(new Error("Pi cancelled creation of the native session"), { code: "runtime-rejected" });
      }

      // Capture and persist the native identity before any cosmetic follow-up.
      // A failed title write must never make an already-created session ambiguous.
      const state = await currentState();
      const created = nativeIdOf(state);
      if (!created) {
        throw Object.assign(new Error(context.privateSession ? "Pi did not report the private session id" : "Pi did not expose a persistent session file"), { code: "runtime-rejected" });
      }
      nativeId = created;
      createOperationId = operationId;
      await rpc.receipt(operationId, nativeId);

      // Only an authored title belongs in Pi's own session list. A Polyth
      // placeholder or prompt-derived fallback must not shadow the name Pi's
      // generated title (or the first user message) would otherwise show.
      const requestedTitle = canonical.title?.trim() ?? "";
      if (isExplicitSessionTitle(requestedTitle, canonical.titleSource, canonical.sessionId)) {
        polythFallbackTitle = "";
        sessionTitle = requestedTitle;
        await rpc.request({ type: "set_session_name", name: requestedTitle }, 10_000).catch(() => undefined);
      } else {
        polythFallbackTitle = requestedTitle;
        sessionTitle = "";
      }
      return { backendSessionId: nativeId };
    });
    return outcome.kind === "confirmed" ? { ...outcome, receipt: nativeId } : outcome;
  };

  const runtime: AgentRuntime = {
    capabilities: async () => PI_CAPABILITIES,
    commands: nativeCommands,
    models,
    agents: async () => [],
    async ensureSession(input) {
      if (input.sessionId) activeSessionId = input.sessionId;
      if (!input.backendSessionId) {
        throw Object.assign(new Error("Pi requires a persistent native session path"), { code: "unknown-session" });
      }
      polythFallbackTitle = isExplicitSessionTitle(input.title, input.titleSource, input.sessionId)
        ? ""
        : input.title?.trim() ?? "";
      const state = await currentState();
      if (nativeIdOf(state) === input.backendSessionId) {
        nativeId = input.backendSessionId;
        adoptNativeTitle(state.sessionName);
        return nativeId;
      }
      // There is no file to switch to: the private session ended with the
      // process that held it.
      if (context.privateSession) {
        throw Object.assign(new Error("A private Pi session cannot be reopened after its process ended"), { code: "unknown-session" });
      }
      const switched = await rpc.request<{ cancelled?: boolean }>({
        type: "switch_session",
        sessionPath: input.backendSessionId,
      }, 30_000);
      if (switched?.cancelled) {
        throw Object.assign(new Error("Pi cancelled the native session switch"), { code: "unknown-session" });
      }
      const verified = await currentState();
      if (verified.sessionFile !== input.backendSessionId) {
        throw Object.assign(new Error("Pi switched to a different native session than requested"), { code: "unknown-session" });
      }
      nativeId = input.backendSessionId;
      adoptNativeTitle(verified.sessionName);
      return nativeId;
    },
    createSessionOperation: createSession,
    resetSessionOperation: createSession,
    sessions: async () => Object.entries(rpc.receipts).map(([operationId, id]) => ({
      id,
      operationId,
      title: id === nativeId ? sessionTitle : "",
      createdAt: 0,
      updatedAt: 0,
    })),
    history: async () => [],
    async startTurnOperation(request, operationId) {
      if (request.sessionId) activeSessionId = request.sessionId;
      if (!connected) {
        return { kind: "unknown", operationId, message: "Pi RPC runtime is disconnected and requires recovery" };
      }
      if (activeOperationId) {
        return { kind: "rejected", code: "busy", message: "Pi is already processing a turn" };
      }
      if (!nativeId) {
        return { kind: "rejected", code: "unknown-session", message: "Pi native session is not established" };
      }

      try {
        if (request.model) {
          await rpc.request({
            type: "set_model",
            provider: request.model.providerID,
            modelId: request.model.modelID,
          }, 20_000);
          await rpc.request({
            type: "set_thinking_level",
            level: request.model.variant ?? "off",
          }, 10_000);
        }
      } catch (error) {
        return (error as { code?: string }).code === "runtime-rejected"
          ? { kind: "rejected", code: "runtime-rejected", message: error instanceof Error ? error.message : "Pi rejected model selection" }
          : { kind: "unknown", operationId, message: "Pi did not confirm model selection" };
      }

      const delivered = composeTurnPrompt(request.text, request.attachments);
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      const seenImagePaths = new Set<string>();
      const addImage = async (path: string, mime: string) => {
        const absolute = isAbsolute(path) ? path : join(context.cwd, path);
        if (seenImagePaths.has(absolute)) return;
        const data = await readFile(absolute);
        seenImagePaths.add(absolute);
        images.push({ type: "image", data: data.toString("base64"), mimeType: mime });
      };

      try {
        for (const image of delivered.images) await addImage(image.localPath, image.mime);
        for (const attachment of request.attachments ?? []) {
          if (attachment.kind === "browser-context") continue;
          const modality = attachmentModality(attachment);
          if (modality !== "image") {
            return {
              kind: "rejected",
              code: "unsupported",
              message: unsupportedAttachmentMessage(modality, "Pi"),
            };
          }
          if (!attachment.path) {
            return { kind: "rejected", code: "invalid-attachment", message: `${attachment.name} could not be read.` };
          }
          await addImage(attachment.path, attachment.mime);
        }
      } catch {
        return { kind: "rejected", code: "invalid-attachment", message: "Pi image attachment could not be read" };
      }

      // Pi's own turn events carry no model, so the canonical `turn/started`
      // must publish one. Use the requested ref, or the native selection the
      // turn inherits when the request omitted it (native Auto / persisted
      // profile model). Without this the activity dock falls back to "Auto"
      // for every Pi turn.
      let provider = request.model?.providerID?.trim();
      let startedModel: ModelRef | undefined = request.model;
      if (!startedModel || !provider) {
        try {
          const nativeModel = (await currentState()).model;
          provider ||= nativeModel?.provider?.trim();
          startedModel ??= modelRefFromState({ model: nativeModel });
        } catch {
          // Provider identity is advisory for failure classification; a native
          // terminal error can still be retried without it.
        }
      }
      activeOperationId = operationId;
      activeProvider = provider ?? "";
      assistantMessageOrdinal = 0;
      activeAssistantOrdinal = 0;
      streamed.clear();
      abortRequested = false;
      lastStopReason = "";
      lastError = "";
      order++;
      try {
        // Pi's correlated prompt response is the admission receipt. All later
        // failures are represented by native events and the settled terminal.
        await rpc.request({
          type: "prompt",
          message: delivered.text,
          ...(images.length ? { images } : {}),
        }, 30_000);
        accepted.push({ operationId, mutationKind: "turn-submit" });
        emit({ type: "turn/started", turnId: operationId, ...(startedModel ? { model: startedModel } : {}) });
        return { kind: "confirmed", value: { admissionId: operationId } };
      } catch (error) {
        activeOperationId = "";
        activeProvider = "";
        streamed.clear();
        const code = (error as { code?: string }).code;
        return code === "runtime-rejected"
          ? { kind: "rejected", code: "runtime-rejected", message: error instanceof Error ? error.message : "Pi rejected the prompt" }
          : { kind: "unknown", operationId, message: "Pi prompt admission was not confirmed" };
      }
    },
    startTurn: async () => { throw new Error("operation-aware admission required"); },
    async abort() {
      await rpc.request({ type: "clear_queue" }, 10_000).catch(() => undefined);
      abortRequested = true;
      // Upstream guarantees this response is sent only once the session is idle.
      await rpc.request({ type: "abort" }, 60_000);
    },
    async abortOperation(_sessionId, operationId) {
      return mutation(operationId, async () => {
        await runtime.abort(context.sessionId ?? "");
        return {};
      });
    },
    replyPermission: async () => {
      throw Object.assign(new Error("Pi permission bridge is not exposed by this adapter"), { code: "unsupported" });
    },
    replyQuestion: async () => {
      throw Object.assign(new Error("Pi question bridge is not exposed by this adapter"), { code: "unsupported" });
    },
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    async reconcile(binding) {
      if (binding.canonicalSessionId) activeSessionId = binding.canonicalSessionId;
      // A probe that times out is this snapshot's missing evidence, not a dead
      // transport: Pi answers `get_state` only after an in-flight abort has
      // killed its tool. Only `rpc.onClose` latches the disconnect, otherwise
      // one slow probe would refuse every later prompt on a live process.
      let state: PiRpcState | undefined;
      try {
        state = await currentState();
      } catch {
        state = undefined;
      }
      const currentNative = nativeIdOf(state);
      if (currentNative) nativeId = currentNative;
      const matches = connected && !!state && !!binding.backendSessionId && currentNative === binding.backendSessionId;
      return {
        ...endpoint,
        backendSessionId: binding.backendSessionId ?? currentNative ?? nativeId,
        reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
        state: {
          value: !matches ? "unknown" : state?.isStreaming ? "running" : "idle",
          comparison: { domain: rpc.authorityId, order: ++order },
          ...(createOperationId && accepted.length === 0 ? { causalOperationId: createOperationId } : {}),
        },
        completeness: {
          events: "partial",
          permissions: connected ? "complete" : "unverifiable",
          questions: "complete",
        },
        events: [],
        permissions: [],
        questions: [],
        acceptedOperations: accepted,
      } satisfies RuntimeSnapshot;
    },
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); } };
    },
    onLifecycle(callback) {
      lifecycle.add(callback);
      return { dispose: () => { lifecycle.delete(callback); } };
    },
    async dispose() {
      eventSubscription.dispose();
      closeSubscription.dispose();
      await rpc.close();
    },
  };

  return runtime;
}
