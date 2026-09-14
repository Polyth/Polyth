import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentRuntime,
  HarnessContext,
  ModelDescriptor,
  MutationOutcome,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSnapshot,
} from "@polyth/contracts";
import type { CommandCodeRpc, CommandCodeWorkerEvent } from "./rpc.ts";
import { createCommandCodeTranslateState, translateCommandCodeRecord } from "./protocol.ts";

export const COMMANDCODE_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  permissions: false,
  questions: false,
  compaction: false,
  // Official AgentEvents expose nested-agent lifecycle/progress. This claim is
  // observability only; Polyth does not pretend it can independently spawn or
  // control Command Code subagents.
  subagents: true,
  // Command Code consumes its own native MCP configuration from the execution
  // cwd. Polyth provisioning/mutability remains a separate capability seam.
  mcp: true,
  steering: true,
  resume: true,
  usage: true,
  cost: false,
  fork: false,
  title: "native",
  attachments: {
    modalities: {
      image: "unsupported",
      file: "unsupported",
      url: "unsupported",
      pdf: "unsupported",
      audio: "unsupported",
    },
  },
  commands: { discovery: "unsupported", invoke: "unsupported" },
  contextOccupancy: "unknown",
};

type CommandCodeAcceptedMutation = {
  operationId: string;
  mutationKind: "turn-submit" | "turn-steer";
};

interface BindingState {
  version: 1;
  bindingId: string;
  operationId: string;
  title: string;
  createdAt?: number;
  nativeSessionId?: string;
  nativeBoundAt?: number;
  acceptedOperations?: string[];
  acceptedMutations?: CommandCodeAcceptedMutation[];
  updatedAt: number;
}

const safeError = (value: unknown): string => String(value ?? "Command Code failed")
  .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 500);

const validAcceptedMutation = (value: unknown): value is CommandCodeAcceptedMutation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<CommandCodeAcceptedMutation>;
  return typeof entry.operationId === "string" && entry.operationId.length > 0
    && (entry.mutationKind === "turn-submit" || entry.mutationKind === "turn-steer");
};

const bindingMutations = (state: BindingState): CommandCodeAcceptedMutation[] => {
  if (state.acceptedMutations?.length) return state.acceptedMutations;
  return (state.acceptedOperations ?? []).map((operationId) => ({ operationId, mutationKind: "turn-submit" }));
};

const readBinding = async (file: string): Promise<BindingState | undefined> => {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<BindingState>;
    if (
      value.version !== 1
      || typeof value.bindingId !== "string"
      || typeof value.operationId !== "string"
      || typeof value.title !== "string"
      || typeof value.updatedAt !== "number"
      || (value.createdAt !== undefined && typeof value.createdAt !== "number")
      || (value.nativeSessionId !== undefined && typeof value.nativeSessionId !== "string")
      || (value.nativeBoundAt !== undefined && typeof value.nativeBoundAt !== "number")
      || (value.acceptedOperations !== undefined && (
        !Array.isArray(value.acceptedOperations)
        || !value.acceptedOperations.every((operationId) => typeof operationId === "string" && operationId.length > 0)
      ))
      || (value.acceptedMutations !== undefined && (
        !Array.isArray(value.acceptedMutations)
        || !value.acceptedMutations.every(validAcceptedMutation)
      ))
    ) return undefined;
    return value as BindingState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const writeBinding = async (file: string, value: BindingState): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, file);
};

const mutation = async <T>(operationId: string, action: () => Promise<T>): Promise<MutationOutcome<T>> => {
  try {
    return { kind: "confirmed", value: await action() };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "runtime-rejected" || code === "busy" || code === "unsupported") {
      return { kind: "rejected", code: code ?? "runtime-rejected", message: safeError(error instanceof Error ? error.message : error) };
    }
    return { kind: "unknown", operationId, message: safeError(error instanceof Error ? error.message : error) };
  }
};

const exitMessage = (code: number | null, stderr: unknown, result: Record<string, unknown> | undefined): string => {
  const resultError = typeof result?.error === "string" ? result.error : undefined;
  if (resultError) return safeError(resultError);
  const suffix = typeof stderr === "string" && stderr.trim() ? `: ${safeError(stderr)}` : "";
  switch (code) {
    case 3: return `Command Code authentication is required${suffix}`;
    case 4: return `Command Code permission denied${suffix}`;
    case 5: return `Command Code rate limit reached${suffix}`;
    case 6: return `Command Code network request failed${suffix}`;
    case 7: return `Command Code service error${suffix}`;
    case 8: return `Command Code reached its turn limit${suffix}`;
    case 9: return `Command Code returned no model response${suffix}`;
    case 10: return `Command Code credits are insufficient${suffix}`;
    default: return `Command Code exited with code ${code ?? "unknown"}${suffix}`;
  }
};

export function createCommandCodeRuntime(options: {
  context: HarnessContext;
  rpc: CommandCodeRpc;
  bindingFile: string;
  bridgePath: string;
  models(): Promise<ModelDescriptor[]>;
}): AgentRuntime {
  const { context, rpc, bindingFile, bridgePath } = options;
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
  const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
  let connected = true;
  let bindingId = "";
  let nativeSessionId = "";
  let createOperationId = "";
  let activeOperationId = "";
  let activeSpawnConfirmed = false;
  let activeFailure = "";
  let abortRequested = false;
  let translateState: ReturnType<typeof createCommandCodeTranslateState> | undefined;
  let lastResult: Record<string, unknown> | undefined;
  let order = 0;

  const endpoint = {
    authorityId: rpc.authorityId,
    generation: rpc.generation,
    continuity: "generation-only" as const,
    url: "stdio:command-code-worker",
    location: { directory: context.cwd },
    control: { kind: "owned" as const, instanceToken: rpc.authorityId },
    config: { kind: "read-only" as const },
    authentication: { kind: "none" as const },
  };

  const emit = (event: RuntimeEvent) => {
    if (!context.sessionId) return;
    for (const callback of listeners) callback(context.sessionId, event);
  };

  const rememberAccepted = (
    operationId: string,
    mutationKind: CommandCodeAcceptedMutation["mutationKind"] = "turn-submit",
  ) => {
    if (!operationId || accepted.some((entry) => entry.operationId === operationId && entry.mutationKind === mutationKind)) return;
    accepted.push({ operationId, mutationKind });
  };

  const rememberBindingAccepted = (state: BindingState) => {
    for (const entry of bindingMutations(state)) rememberAccepted(entry.operationId, entry.mutationKind);
  };

  const hasBindingReceipt = (
    state: BindingState | undefined,
    operationId: string,
    mutationKind: CommandCodeAcceptedMutation["mutationKind"],
  ): boolean => Boolean(state && bindingMutations(state).some((entry) =>
    entry.operationId === operationId && entry.mutationKind === mutationKind));

  const clearActiveTurn = () => {
    activeOperationId = "";
    activeSpawnConfirmed = false;
    activeFailure = "";
    abortRequested = false;
    translateState = undefined;
    lastResult = undefined;
  };

  const handleWorkerEvent = (message: CommandCodeWorkerEvent) => {
    if (message.type === "turn-spawned" && message.operationId === activeOperationId) {
      activeSpawnConfirmed = true;
      return;
    }
    if ((message.type === "protocol-error" || message.type === "process-error") && message.operationId === activeOperationId) {
      activeFailure = safeError(message.error);
      return;
    }
    if (message.type === "commandcode-record") {
      if (message.operationId !== activeOperationId || !translateState) return;
      const outer = message.record && typeof message.record === "object" && !Array.isArray(message.record)
        ? message.record as Record<string, unknown>
        : undefined;
      if (outer?.type === "result") lastResult = outer;
      for (const event of translateCommandCodeRecord(message.record, translateState)) emit(event);
      return;
    }
    if (message.type !== "turn-exit" || message.operationId !== activeOperationId) return;
    const turnId = activeOperationId;
    const failure = activeFailure;
    const wasAborted = abortRequested;
    const result = lastResult;
    const code = typeof message.code === "number" ? message.code : null;
    const subtype = typeof result?.subtype === "string" ? result.subtype : undefined;
    clearActiveTurn();
    order++;
    if (failure) {
      emit({ type: "turn/stopped", turnId, reason: "error", error: failure });
    } else if (wasAborted || code === 130 || message.signal === "SIGINT") {
      emit({ type: "turn/stopped", turnId, reason: "aborted" });
    } else if (code === 0 && (!subtype || subtype === "success")) {
      emit({ type: "turn/stopped", turnId, reason: "completed" });
    } else {
      emit({ type: "turn/stopped", turnId, reason: "error", error: exitMessage(code, message.stderr, result) });
    }
  };

  const eventSubscription = rpc.onEvent(handleWorkerEvent);
  const closeSubscription = rpc.onClose(() => {
    connected = false;
    for (const callback of lifecycle) callback({ type: "stream-disconnected", authorityId: rpc.authorityId, generation: rpc.generation });
  });

  const createSession: NonNullable<AgentRuntime["createSessionOperation"]> = async (canonical, operationId) => {
    const recovered = await readBinding(bindingFile);
    if (recovered?.operationId === operationId) {
      bindingId = recovered.bindingId;
      nativeSessionId = recovered.nativeSessionId ?? "";
      createOperationId = operationId;
      rememberBindingAccepted(recovered);
      await rpc.receipt(operationId, bindingId);
      return { kind: "confirmed", value: { backendSessionId: bindingId }, receipt: bindingId };
    }
    const existingReceipt = rpc.receipts[operationId];
    if (existingReceipt) {
      if (!recovered || recovered.bindingId !== existingReceipt) {
        return { kind: "unknown", operationId, message: "Command Code binding receipt exists but its durable state is unavailable" };
      }
      bindingId = recovered.bindingId;
      nativeSessionId = recovered.nativeSessionId ?? "";
      createOperationId = operationId;
      rememberBindingAccepted(recovered);
      return { kind: "confirmed", value: { backendSessionId: bindingId }, receipt: bindingId };
    }
    return mutation(operationId, async () => {
      const now = Date.now();
      const next: BindingState = {
        version: 1,
        bindingId: `commandcode:${randomUUID()}`,
        operationId,
        title: canonical.title?.trim() || "Command Code session",
        createdAt: now,
        acceptedOperations: [],
        acceptedMutations: [],
        updatedAt: now,
      };
      await writeBinding(bindingFile, next);
      await rpc.receipt(operationId, next.bindingId);
      bindingId = next.bindingId;
      nativeSessionId = "";
      createOperationId = operationId;
      return { backendSessionId: bindingId };
    }).then((outcome) => outcome.kind === "confirmed" ? { ...outcome, receipt: bindingId } : outcome);
  };

  const runtime: AgentRuntime = {
    harnessId: "commandcode",
    capabilities: async () => COMMANDCODE_CAPABILITIES,
    models: options.models,
    agents: async () => [],
    commands: async () => [],
    async ensureSession(input) {
      if (!input.backendSessionId) throw Object.assign(new Error("Command Code binding id is required"), { code: "unknown-session" });
      const state = await readBinding(bindingFile);
      if (!state || state.bindingId !== input.backendSessionId) {
        throw Object.assign(new Error("Command Code binding does not match the canonical runtime leg"), { code: "unknown-session" });
      }
      bindingId = state.bindingId;
      nativeSessionId = state.nativeSessionId ?? "";
      createOperationId = state.operationId;
      rememberBindingAccepted(state);
      return bindingId;
    },
    createSessionOperation: createSession,
    resetSessionOperation: createSession,
    async sessions() {
      const state = await readBinding(bindingFile);
      return state ? [{
        id: state.bindingId,
        operationId: state.operationId,
        title: state.title,
        createdAt: state.createdAt ?? state.updatedAt,
        updatedAt: state.updatedAt,
      }] : [];
    },
    history: async () => [],
    async startTurnOperation(request, operationId) {
      if (!connected) return { kind: "unknown", operationId, message: "Command Code worker is disconnected" };
      if (activeOperationId) return { kind: "rejected", code: "busy", message: "Command Code is already processing a turn" };
      const state = await readBinding(bindingFile);
      if (!state || !bindingId || state.bindingId !== bindingId) {
        return { kind: "rejected", code: "unknown-session", message: "Command Code native binding is not established" };
      }
      if (request.attachments?.length) {
        return { kind: "rejected", code: "unsupported", message: "Command Code attachment translation is not enabled yet" };
      }
      activeOperationId = operationId;
      activeSpawnConfirmed = false;
      activeFailure = "";
      abortRequested = false;
      lastResult = undefined;
      translateState = createCommandCodeTranslateState(operationId, request.model);
      try {
        const result = await rpc.request<{ nativeSessionId: string }>({
          type: "start_turn",
          operationId,
          cwd: context.cwd,
          text: request.command ? `/${request.command.name}${request.command.args ? ` ${request.command.args}` : ""}` : request.text,
          bindingPath: bindingFile,
          bridgePath,
          title: state.title,
          ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}),
          ...(request.model ? { model: request.model.modelID } : {}),
          ...(request.model?.variant ? { effort: request.model.variant } : {}),
        }, 20_000);
        if (!result.nativeSessionId) throw Object.assign(new Error("Command Code admission omitted native session id"), { code: "outcome-unknown" });
        nativeSessionId = result.nativeSessionId;
        rememberAccepted(operationId, "turn-submit");
        return { kind: "confirmed", value: { admissionId: nativeSessionId } };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if ((code === "busy" || code === "unsupported") && !activeSpawnConfirmed && activeOperationId === operationId) {
          clearActiveTurn();
          return { kind: "rejected", code, message: safeError(error instanceof Error ? error.message : error) };
        }
        // Once the worker has spawned Command Code, a lost admission response
        // is not permission to clear the operation or submit another turn. The
        // bridge may already have released native inference after durably
        // recording this operation id. Keep the execution fenced until exact
        // terminal evidence or release/reconciliation resolves it.
        const durable = await readBinding(bindingFile).catch(() => undefined);
        if (durable) rememberBindingAccepted(durable);
        return { kind: "unknown", operationId, message: safeError(error instanceof Error ? error.message : error) };
      }
    },
    startTurn: async () => { throw new Error("operation-aware Command Code admission is required"); },
    async steer(_sessionId, text) {
      if (!activeOperationId) return false;
      const operationId = `compat-steer:${randomUUID()}`;
      const outcome = await runtime.steerOperation!(_sessionId, text, operationId);
      if (outcome.kind === "confirmed") return true;
      if (outcome.kind === "rejected") return false;
      throw Object.assign(new Error(outcome.message), { code: "outcome-unknown", operationId });
    },
    async steerOperation(_sessionId, text, operationId) {
      if (!connected) return { kind: "unknown", operationId, message: "Command Code worker is disconnected" };
      if (!activeOperationId) {
        return { kind: "rejected", code: "runtime-rejected", message: "Command Code has no active turn to steer" };
      }
      try {
        await rpc.request({ type: "steer", operationId, text }, 7_500);
        rememberAccepted(operationId, "turn-steer");
        return { kind: "confirmed", value: {} };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "runtime-rejected" || code === "busy" || code === "unsupported") {
          return { kind: "rejected", code, message: safeError(error instanceof Error ? error.message : error) };
        }
        const durable = await readBinding(bindingFile).catch(() => undefined);
        if (hasBindingReceipt(durable, operationId, "turn-steer")) {
          rememberAccepted(operationId, "turn-steer");
          return { kind: "confirmed", value: {} };
        }
        return { kind: "unknown", operationId, message: safeError(error instanceof Error ? error.message : error) };
      }
    },
    async abort() {
      if (activeOperationId) abortRequested = true;
      await rpc.request({ type: "abort" }, 65_000);
    },
    async abortOperation(_sessionId, operationId) {
      return mutation(operationId, async () => { await runtime.abort(context.sessionId ?? ""); return {}; });
    },
    replyPermission: async () => { throw Object.assign(new Error("Command Code interactive permission bridge is not enabled yet"), { code: "unsupported" }); },
    replyQuestion: async () => { throw Object.assign(new Error("Command Code interactive question bridge is not enabled yet"), { code: "unsupported" }); },
    endpoint: async () => endpoint,
    protocol: async () => "legacy",
    async reconcile(binding) {
      const state = await readBinding(bindingFile).catch(() => undefined);
      const matches = connected && !!state && !!binding.backendSessionId && state.bindingId === binding.backendSessionId;
      if (state) {
        bindingId = state.bindingId;
        nativeSessionId = state.nativeSessionId ?? "";
        rememberBindingAccepted(state);
      }
      return {
        ...endpoint,
        backendSessionId: binding.backendSessionId ?? state?.bindingId ?? bindingId,
        reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
        state: {
          value: !matches ? "unknown" : activeOperationId ? "running" : "idle",
          comparison: { domain: rpc.authorityId, order: ++order },
          ...(createOperationId && accepted.length === 0 ? { causalOperationId: createOperationId } : {}),
        },
        completeness: { events: "partial", permissions: "complete", questions: "complete" },
        events: [],
        permissions: [],
        questions: [],
        acceptedOperations: accepted,
      } satisfies RuntimeSnapshot;
    },
    onEvent(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    onLifecycle(callback) { lifecycle.add(callback); return { dispose: () => lifecycle.delete(callback) }; },
    async dispose() {
      eventSubscription.dispose();
      closeSubscription.dispose();
      await rpc.close();
    },
  };
  return runtime;
}
