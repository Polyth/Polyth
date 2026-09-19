import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  AgentRuntime,
  HarnessContext,
  JsonObject,
  ModelDescriptor,
  MutationOutcome,
  RuntimeCapabilities,
  RuntimeCommandDescriptor,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@polyth/contracts";
import {
  attachmentModality,
  composeTurnPrompt,
  contextWindowTelemetry,
  unsupportedAttachmentMessage,
} from "@polyth/harness-runtime";
import type { PiRpc, PiRpcEvent, PiRpcModel, PiRpcSessionStats, PiRpcState } from "./rpc.ts";

export const PI_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: false,
  questions: false,
  compaction: false,
  subagents: false,
  mcp: false,
  steering: false,
  resume: true,
  usage: false,
  cost: false,
  fork: false,
  title: "native",
  attachments: {
    modalities: {
      image: "native",
      file: "unsupported",
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

export function createPiRuntime(context: HarnessContext, rpc: PiRpc): AgentRuntime {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
  const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
  let nativeId = "";
  let createOperationId = "";
  let activeOperationId = "";
  let assistantMessageOrdinal = 0;
  let activeAssistantOrdinal = 0;
  let connected = true;
  let abortRequested = false;
  let lastStopReason = "";
  let lastError = "";
  let order = 0;
  const streamed = new Map<number, string>();

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
    if (!context.sessionId) return;
    for (const callback of listeners) callback(context.sessionId, event);
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
    activeOperationId = "";
    streamed.clear();
    order++;
    if (abortRequested || lastStopReason === "aborted") {
      emit({ type: "turn/stopped", turnId, reason: "aborted" });
    } else if (lastStopReason === "error") {
      emit({
        type: "turn/stopped",
        turnId,
        reason: "error",
        error: lastError || "Pi reported a native model error",
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
      }
      return;
    }

    if (type === "message_update" && activeOperationId) {
      const delta = asRecord(event.assistantMessageEvent);
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
      if (blocks.length) {
        for (const block of blocks) {
          emit({ type: "assistant/message", partId: partId(block.index), text: block.text });
        }
      } else {
        for (const [index, text] of [...streamed].sort(([a], [b]) => a - b)) {
          if (text) emit({ type: "assistant/message", partId: partId(index), text });
        }
      }
      lastStopReason = typeof message.stopReason === "string" ? message.stopReason : lastStopReason;
      lastError = typeof message.errorMessage === "string" ? message.errorMessage : lastError;
      streamed.clear();
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
          id: `native:pi:${name}`,
          name,
          ...(typeof command?.description === "string" ? { description: command.description } : {}),
          owner: "native" as const,
          harnessId: "pi",
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
    const outcome = await mutation(operationId, async () => {
      const result = await rpc.request<{ cancelled?: boolean }>({ type: "new_session" }, 30_000);
      if (result?.cancelled) {
        throw Object.assign(new Error("Pi cancelled creation of the native session"), { code: "runtime-rejected" });
      }

      // Capture and persist the native identity before any cosmetic follow-up.
      // A failed title write must never make an already-created session ambiguous.
      const state = await currentState();
      if (!state.sessionFile) {
        throw Object.assign(new Error("Pi did not expose a persistent session file"), { code: "runtime-rejected" });
      }
      nativeId = state.sessionFile;
      createOperationId = operationId;
      await rpc.receipt(operationId, nativeId);

      if (canonical.title?.trim()) {
        await rpc.request({ type: "set_session_name", name: canonical.title.trim() }, 10_000).catch(() => undefined);
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
      if (!input.backendSessionId) {
        throw Object.assign(new Error("Pi requires a persistent native session path"), { code: "unknown-session" });
      }
      const state = await currentState();
      if (state.sessionFile === input.backendSessionId) {
        nativeId = input.backendSessionId;
        return nativeId;
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
      return nativeId;
    },
    createSessionOperation: createSession,
    resetSessionOperation: createSession,
    sessions: async () => Object.entries(rpc.receipts).map(([operationId, id]) => ({
      id,
      operationId,
      title: "Pi session",
      createdAt: 0,
      updatedAt: 0,
    })),
    history: async () => [],
    async startTurnOperation(request, operationId) {
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
          if (request.model.variant) {
            await rpc.request({ type: "set_thinking_level", level: request.model.variant }, 10_000);
          }
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

      activeOperationId = operationId;
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
        emit({ type: "turn/started", turnId: operationId });
        return { kind: "confirmed", value: { admissionId: operationId } };
      } catch (error) {
        activeOperationId = "";
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
      let state: PiRpcState | undefined;
      try {
        state = await currentState();
      } catch {
        connected = false;
      }
      const currentNative = state?.sessionFile;
      if (currentNative) nativeId = currentNative;
      const matches = connected && !!binding.backendSessionId && currentNative === binding.backendSessionId;
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
