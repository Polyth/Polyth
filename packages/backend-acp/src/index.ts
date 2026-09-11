export { registerAcpProfile } from "./profile.ts";
export { createAcpProvisioner } from "./provisioner.ts";
export {
    discoverAcpModels,
    invalidateAcpDiscovery,
    type AcpDiscoveryOptions,
    type AcpDiscoveryResult,
} from "./discovery.ts";
export {
    acpModelDescriptors,
    applyConfigOptionUpdate,
    currentModelId,
    explicitThoughtLevelReset,
    modelControl,
    parseSessionConfig,
    type AcpModelControl,
    type AcpSessionConfig,
} from "./sessionConfig.ts";
import { randomUUID } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntime, HarnessContext, HarnessDescriptor, HarnessProvider, JsonObject, ModelDescriptor, MutationOutcome, RuntimeCommandDescriptor, RuntimeEvent, RuntimeSnapshot } from "@polyth/contracts";
import {
    acknowledgeCapabilityApplication,
    attachmentModality,
    captureCapabilityLaunch,
    composeTurnPrompt,
    contextWindowTelemetry,
    createStdioRpc,
    materializeAttachmentText,
    provisioningTarget,
    releaseCapabilityLaunch,
    resolveModelSelection,
    unsupportedAttachmentMessage,
    type RpcPeer,
} from "@polyth/harness-runtime";
import { acpOverlays, type AcpLaunchOverlay } from "./provisioner.ts";
import {
    acpModelDescriptors,
    applyConfigOptionUpdate,
    currentModelId,
    explicitThoughtLevelReset,
    modelControl,
    parseSessionConfig,
    type AcpSessionConfig,
} from "./sessionConfig.ts";
export interface AcpProfile {
    descriptor: HarnessDescriptor;
    command: string;
    args: string[];
    /** Verified native authentication check; never read credential files. */
    probe: HarnessProvider["probe"];
    /** Disable when native catalog IDs already encode all model variants. */
    probeModelControls?: boolean;
    /** Provider-specific, read-only catalog discovery. Undefined falls back
     * to the standard throwaway `session/new` path. */
    discoverModels?(connection: AcpConnection, context: HarnessContext): Promise<ModelDescriptor[] | undefined>;
    /** Native client extension metadata advertised during `initialize`. */
    initializeClientMeta?: JsonObject;
    /**
     * Optional gate on cold model discovery. Some agent generations cannot
     * answer it, and spawning them to find that out every time is wasted work.
     * The refusal reason is shown to the user, so it must name a real cause.
     */
    supportsModelDiscovery?(probe: Awaited<ReturnType<HarnessProvider["probe"]>>):
        | { ok: true }
        | { ok: false; reason: string };
}
export interface AcpAgentCapabilities {
    loadSession?: boolean;
    sessionCapabilities?: {
        /** ACP v1 advertises this as `{}`, not `true`. */
        resume?: unknown;
    };
    promptCapabilities?: {
        image?: boolean;
        audio?: boolean;
        /** Whether the agent accepts `resource` blocks carrying file text. */
        embeddedContext?: boolean;
    };
}

/** Native sign-in choices the agent published from `initialize`. */
export interface AcpAuthMethod { id: string; name?: string; description?: string }

const attachmentModalitySupport = (agentCapabilities?: AcpAgentCapabilities) => ({
    image: agentCapabilities?.promptCapabilities?.image === true ? "native" as const : "unsupported" as const,
    audio: agentCapabilities?.promptCapabilities?.audio === true ? "native" as const : "unsupported" as const,
    // With embedded context the file text rides along as an ACP `resource`
    // block; without it the server projects the text into the prompt.
    file: agentCapabilities?.promptCapabilities?.embeddedContext === true
        ? "native" as const
        : "emulated" as const,
    // Baseline ACP requires `resource_link` support in prompts.
    url: "native" as const,
    pdf: "unsupported" as const,
});

/** ACP sessionCapabilities.resume is an empty object when present. */
const acpAdvertised = (value: unknown): boolean =>
    value === true || (typeof value === "object" && value !== null);

const ACP_TEXT_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

const confinedAttachmentPath = async (root: string, candidate: string): Promise<string> => {
    const rootPath = await realpath(root);
    const target = await realpath(isAbsolute(candidate) ? candidate : resolve(rootPath, candidate));
    const rel = relative(rootPath, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw Object.assign(new Error("Attachment path escapes the execution root"), { code: "invalid-attachment" });
    }
    return target;
};

const readBoundedTextSource = async (path: string): Promise<Uint8Array> => {
    const handle = await open(path, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > ACP_TEXT_SOURCE_MAX_BYTES) {
            throw Object.assign(new Error("Attachment is not a bounded regular file"), { code: "invalid-attachment" });
        }
        const bytes = new Uint8Array(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        return bytes.subarray(0, offset);
    } finally {
        await handle.close();
    }
};

export const ACP_STATIC_FEATURES = {
    streaming: true,
    permissions: true,
    questions: false,
    compaction: false,
    subagents: false,
    steering: false,
    usage: false,
    cost: false,
    fork: false,
    mcp: true,
    title: "native" as const,
    // Before any agent has advertised anything: image/audio need a live
    // `promptCapabilities`, a text file can always be projected server-side,
    // and `resource_link` is baseline ACP.
    attachments: { modalities: attachmentModalitySupport() },
    commands: { discovery: "native" as const, invoke: "raw-native-input" as const },
    contextOccupancy: "unknown" as const,
    resume: false,
};
export interface AcpConnection {
    rpc: RpcPeer;
    agentCapabilities?: AcpAgentCapabilities;
    authMethods?: AcpAuthMethod[];
}

export interface AcpRuntimeOptions {
    /** Maximum silence while a native prompt is active. Activity resets the
     * watchdog; zero disables it for protocol fixtures that own their clock. */
    promptIdleTimeoutMs?: number;
    /** Model-specific controls learned from capability-probed discovery. */
    models?: ModelDescriptor[];
}

const parseAuthMethods = (value: unknown): AcpAuthMethod[] =>
    (Array.isArray(value) ? value : []).flatMap((entry) => {
        const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
        const id = row && typeof row.id === "string" && row.id ? row.id : undefined;
        if (!id) return [];
        return [{
            id,
            ...(typeof row!.name === "string" ? { name: row!.name } : {}),
            ...(typeof row!.description === "string" ? { description: row!.description } : {}),
        }];
    });
/** ACP v1 is deliberately version-pinned. V2 changes prompt admission and
 * session lifecycle; it must not be guessed from a superficially similar API. */
export async function connectAcp(profile: AcpProfile, context: HarnessContext, stateFile?: string, signal?: AbortSignal): Promise<AcpConnection> {
    const rpc = await createStdioRpc({ command: profile.command, args: profile.args, cwd: context.cwd, stateFile });
    const abort = () => { void rpc.close().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
        if (signal?.aborted) throw Object.assign(new Error("ACP connection cancelled"), { code: "discovery-unavailable" });
        const result = await rpc.request<{
            protocolVersion: number;
            agentCapabilities?: AcpAgentCapabilities;
            authMethods?: unknown;
        }>("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                ...(profile.initializeClientMeta ? { _meta: profile.initializeClientMeta } : {}),
            },
            clientInfo: { name: "polyth", version: "0.1.0" },
        });
        if (result.protocolVersion !== 1)
            throw new Error("unsupported ACP version");
        const authMethods = parseAuthMethods(result.authMethods);
        return { rpc, agentCapabilities: result.agentCapabilities, ...(authMethods.length ? { authMethods } : {}) };
    }
    catch (error) {
        await rpc.close();
        throw error;
    } finally {
        signal?.removeEventListener("abort", abort);
    }
}
export function createAcpRuntime(
    context: HarnessContext,
    rpc: RpcPeer,
    harnessId = "acp",
    agentCapabilities?: AcpAgentCapabilities,
    /** Display name used in user-facing refusals. */
    descriptorName = harnessId,
    options: AcpRuntimeOptions = {},
): AgentRuntime {
    let nativeId = "";
    let active = false;
    let connected = true;
    let order = 0;
    let createId = "";
    let turnId = "";
    let text = "";
    let messagePartId = "";
    let messagePartOrdinal = 0;
    let resolveAdmission: ((outcome: MutationOutcome<{ admissionId: string }>) => void) | undefined;
    let promptWatchdog: ReturnType<typeof setTimeout> | undefined;
    let lastTitle = "";
    // The agent's own session controls, as advertised. Selection is
    // session-scoped, so it is re-applied after a load/resume.
    let sessionConfig: AcpSessionConfig = {};
    let desiredModelId: string | undefined;
    let desiredVariant: string | undefined;
    /** Model control failure must not erase an independent thought control. */
    let modelSelectionUnavailable = false;
    const thoughtDefaults = new Map<string, string>();
    const rememberThoughtDefault = (allowCurrent: boolean): void => {
        const model = currentModelId(sessionConfig);
        const reset = explicitThoughtLevelReset(sessionConfig)
            ?? (allowCurrent ? sessionConfig.thoughtLevel?.currentValue : undefined);
        if (model && reset) thoughtDefaults.set(model, reset);
    };
    const advertisedModels = (): ModelDescriptor[] => {
        const current = currentModelId(sessionConfig);
        return acpModelDescriptors(sessionConfig, harnessId).map((model) => {
            const { variants: liveVariants, defaultVariant: _defaultVariant, ...base } = model;
            const variants = model.modelID === current
                ? liveVariants
                : options.models?.find((known) => known.modelID === model.modelID)?.variants;
            return variants?.length ? { ...base, variants } : base;
        });
    };
    const nativeCommands: RuntimeCommandDescriptor[] = [];
    const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
    const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
    const pending = new Map<string, {
        resolve(value: unknown): void;
        options: Array<{
            optionId: string;
            kind: string;
        }>;
        permission: string;
        patterns: string[];
    }>();
    const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
    const endpoint = { authorityId: rpc.authorityId, generation: rpc.generation, continuity: "generation-only" as const, url: "stdio:", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: rpc.authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
    const emit = (event: RuntimeEvent) => { for (const cb of listeners)
        cb(context.sessionId!, event); };
    const currentMessagePartId = () => {
        if (!messagePartId) {
            messagePartId = messagePartOrdinal === 0 ? turnId : `${turnId}:${messagePartOrdinal}`;
        }
        return messagePartId;
    };
    const finishMessagePart = () => {
        if (!text || !messagePartId) return;
        emit({ type: "assistant/message", partId: messagePartId, text });
        text = "";
        messagePartId = "";
        messagePartOrdinal++;
    };
    const clearPromptWatchdog = () => {
        if (promptWatchdog) clearTimeout(promptWatchdog);
        promptWatchdog = undefined;
    };
    const promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? 2 * 60_000;
    const failTimedOutPrompt = (expectedTurnId: string) => {
        if (!active || turnId !== expectedTurnId) return;
        clearPromptWatchdog();
        const pendingAdmission = resolveAdmission;
        resolveAdmission = undefined;
        active = false;
        connected = false;
        order++;
        if (pendingAdmission) {
            pendingAdmission({
                kind: "unknown",
                operationId: expectedTurnId,
                message: "ACP prompt timed out before admission was confirmed",
            });
        } else {
            emit({
                type: "turn/stopped",
                turnId: expectedTurnId,
                reason: "error",
                error: "ACP prompt timed out before a terminal result",
                code: "unknown",
            });
        }
        // The request outcome is uncertain, so this authority must not accept
        // another prompt. Closing it also prevents late output from crossing
        // into a recovered runtime generation.
        try { rpc.notify("session/cancel", { sessionId: nativeId }); } catch { /* best effort */ }
        void rpc.close().catch(() => {});
    };
    const touchPromptWatchdog = () => {
        if (!active || promptIdleTimeoutMs <= 0) return;
        clearPromptWatchdog();
        const expectedTurnId = turnId;
        promptWatchdog = setTimeout(() => failTimedOutPrompt(expectedTurnId), promptIdleTimeoutMs);
        promptWatchdog.unref?.();
    };
    const markAccepted = () => { if (resolveAdmission) {
        const done = resolveAdmission;
        resolveAdmission = undefined;
        accepted.push({ operationId: turnId, mutationKind: "turn-submit", receipt: turnId });
        emit({ type: "turn/started", turnId });
        done({ kind: "confirmed", value: { admissionId: turnId }, receipt: turnId });
    } };
    rpc.onClose(() => { connected = false; for (const cb of lifecycle)
        cb({ type: "stream-disconnected", authorityId: rpc.authorityId, generation: rpc.generation }); });
    rpc.onNotification((method, params) => {
        if (method !== "session/update" || params.sessionId !== nativeId)
            return;
        touchPromptWatchdog();
        const update = params.update;
        if (update.sessionUpdate === "config_option_update") {
            sessionConfig = applyConfigOptionUpdate(sessionConfig, update);
            rememberThoughtDefault(false);
            return;
        }
        if (update.sessionUpdate === "current_mode_update") {
            if (typeof update.currentModeId === "string") sessionConfig = { ...sessionConfig, currentModeId: update.currentModeId };
            return;
        }
        // The older unstable model API reports its selection this way.
        if (update.sessionUpdate === "current_model_update") {
            const modelId = typeof update.modelId === "string" ? update.modelId : undefined;
            if (modelId && sessionConfig.legacyModels) {
                sessionConfig = { ...sessionConfig, legacyModels: { ...sessionConfig.legacyModels, current: modelId } };
            }
            return;
        }
        if (update.sessionUpdate === "available_commands_update") {
            const commands = Array.isArray(update.availableCommands)
                ? update.availableCommands
                : Array.isArray(update.commands) ? update.commands : [];
            nativeCommands.splice(0, nativeCommands.length, ...commands.flatMap((command: unknown) => {
                if (!command || typeof command !== "object") return [];
                const value = command as Record<string, unknown>;
                if (typeof value.name !== "string" || !value.name.trim()) return [];
                return [{
                    id: `native:${harnessId}:${value.name}`,
                    name: value.name,
                    ...(typeof value.description === "string" ? { description: value.description } : {}),
                    owner: "native" as const,
                    harnessId,
                    invocation: "raw-native-input" as const,
                    availability: "session" as const,
                    ...(value.input !== undefined ? { acceptsArguments: true } : {}),
                }];
            }));
            emit({ type: "runtime/commands-changed", commands: [...nativeCommands] });
            return;
        }
        if (update.sessionUpdate === "session_info_update") {
            const title = typeof update.title === "string" ? update.title.trim() : "";
            if (title && !/^new session|^untitled|^acp session$/i.test(title)) {
                lastTitle = title;
                emit({ type: "session/title-generated", title });
            }
            return;
        }
        if (update.sessionUpdate === "usage_update") {
            const usedTokens = typeof update.usedTokens === "number"
                ? update.usedTokens
                : typeof update.used === "number" ? update.used : undefined;
            const limitTokens = typeof update.sizeTokens === "number"
                ? update.sizeTokens
                : typeof update.size === "number" ? update.size : undefined;
            if (usedTokens !== undefined || limitTokens !== undefined) {
                emit({ type: "context/updated", ...contextWindowTelemetry({
                    source: "native",
                    usedTokens,
                    limitTokens,
                }) });
            }
            return;
        }
        if (!active) return;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            markAccepted();
            const partId = currentMessagePartId();
            text += update.content.text;
            emit({ type: "assistant/chunk", partId, text: update.content.text });
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            markAccepted();
            // ACP exposes visible prose as chunks but has no message-final
            // notification. A new tool call is the observable boundary
            // between the preceding progress prose and any later final
            // answer. Finalize that part before publishing the tool so the
            // timeline can keep the eventual post-tool part as the answer.
            if (update.sessionUpdate === "tool_call") finishMessagePart();
            if (update.status === "completed" || update.status === "failed")
                emit(update.status === "failed" ? { type: "tool/error", callId: update.toolCallId, tool: update.kind ?? "tool", error: "Tool failed" } : { type: "tool/result", callId: update.toolCallId, tool: update.kind ?? "tool", output: (update.content ?? []).flatMap((c: any) => c.type === "content" && c.content?.type === "text" ? [c.content.text] : []).join("\n") });
            else if (update.sessionUpdate === "tool_call")
                emit({ type: "tool/started", callId: update.toolCallId, tool: update.kind ?? "tool", input: { title: update.title ?? "" } });
        }
        // agent_thought_chunk and vendor-private extensions never enter continuity.
    });
    rpc.onRequest(async (method, params) => {
        if (method !== "session/request_permission" || params.sessionId !== nativeId)
            throw new Error("unsupported request");
        markAccepted();
        const requestId = params.toolCall?.toolCallId ?? randomUUID();
        const permission = params.toolCall?.kind ?? "tool";
        const patterns = [params.toolCall?.title ?? "Tool execution"];
        return new Promise((resolve) => { pending.set(requestId, { resolve, options: params.options ?? [], permission, patterns }); emit({ type: "permission/requested", requestId, permission, patterns }); });
    });
    const mutate = async <T>(operationId: string, action: () => Promise<T>): Promise<MutationOutcome<T>> => {
        try {
            return { kind: "confirmed", value: await action() };
        }
        catch (error) {
            return (error as {
                code?: string;
            }).code === "runtime-rejected" ? { kind: "rejected", code: "runtime-rejected", message: "ACP agent rejected the request" } : { kind: "unknown", operationId, message: "ACP agent did not confirm the request" };
        }
    };
    const withLaunchOverlay = async <T>(
        run: (overlay: AcpLaunchOverlay | undefined) => Promise<T>,
        reason: string,
    ): Promise<T> => {
        const staged = acpOverlays.peek(context, harnessId);
        const launchTarget = provisioningTarget(context, harnessId);
        if (staged) {
            captureCapabilityLaunch({
                target: launchTarget,
                desiredRevision: staged.desiredRevision,
            });
        }
        try {
            const result = await run(staged?.value);
            if (staged) {
                acpOverlays.consumeIfRevision(context, harnessId, staged.desiredRevision);
                acknowledgeCapabilityApplication({
                    target: launchTarget,
                    desiredRevision: staged.desiredRevision,
                    capabilityIds: staged.capabilityIds,
                    outcome: "unverifiable",
                    reason,
                    evidence: {
                        stage: "staged",
                        source: `${reason}; ACP does not expose authoritative connected or tool invocation evidence`,
                    },
                });
            }
            return result;
        }
        catch (error) {
            if (staged) {
                releaseCapabilityLaunch({
                    target: launchTarget,
                    desiredRevision: staged.desiredRevision,
                });
            }
            throw error;
        }
    };
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (_input, operationId) => {
        const outcome = await mutate(operationId, async () => {
            const result = await withLaunchOverlay(async (overlay) => {
                const created = await rpc.request<{
                    sessionId: string;
                }>("session/new", { cwd: context.cwd, mcpServers: overlay?.mcpServers ?? [] });
                if (typeof created?.sessionId !== "string" || !created.sessionId)
                    throw new Error("Native session receipt is invalid");
                return created;
            }, "ACP session/new accepted mcpServers; native model load is unverifiable");
            sessionConfig = parseSessionConfig(result);
            rememberThoughtDefault(true);
            nativeId = result.sessionId;
            createId = operationId;
            await rpc.receipt(operationId, nativeId);
            return { backendSessionId: nativeId };
        });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: nativeId } : outcome;
    };
    const resumeSession = async (backendSessionId: string): Promise<void> => {
        const canResume = acpAdvertised(agentCapabilities?.sessionCapabilities?.resume);
        const canLoad = agentCapabilities?.loadSession === true;
        if (!canResume && !canLoad) {
            throw Object.assign(new Error("ACP v1 adapter cannot resume this session"), { code: "unknown-session" });
        }
        const result = await withLaunchOverlay(async (overlay) => rpc.request(canResume ? "session/resume" : "session/load", {
            sessionId: backendSessionId,
            cwd: context.cwd,
            mcpServers: overlay?.mcpServers ?? [],
        }), canResume
            ? "ACP session/resume accepted mcpServers; native model load is unverifiable"
            : "ACP session/load accepted mcpServers; native model load is unverifiable");
        sessionConfig = parseSessionConfig(result);
        nativeId = backendSessionId;
        // A reloaded session starts on the agent's own selection, so the
        // conversation's choice has to be asserted again.
        const applied = await applySelection(desiredModelId, desiredVariant);
        if (!applied.ok) throw Object.assign(new Error(applied.message), { code: applied.code });
    };

    /**
     * Push the conversation's model/variant onto the native session. Both
     * protocol generations are accepted; an agent that routes neither call is
     * recorded as having no such control instead of failing every later turn.
     */
    const applySelection = async (
        modelId: string | undefined,
        variant: string | undefined,
    ): Promise<{ ok: true } | { ok: false; code: "unsupported" | "native-failure"; message: string }> => {
        const setOption = async (configId: string, value: string) => {
            const updated = await rpc.request<{ configOptions?: unknown }>("session/set_config_option", {
                sessionId: nativeId,
                configId,
                value,
            });
            sessionConfig = applyConfigOptionUpdate(sessionConfig, updated);
        };
        const methodMissing = (error: unknown): boolean =>
            (error as { rpcCode?: number; code?: unknown }).rpcCode === -32601
            || (error as { code?: unknown }).code === -32601
            || /method not found/i.test((error as { message?: string }).message ?? "");
        let operation: "model" | "thought" = "model";
        try {
            if (modelId && modelId !== currentModelId(sessionConfig)) {
                const control = modelControl(sessionConfig);
                if (control.kind === "config-option") await setOption(control.configId, modelId);
                else if (control.kind === "legacy-set-model") {
                    await rpc.request("session/set_model", { sessionId: nativeId, modelId });
                    if (sessionConfig.legacyModels) {
                        sessionConfig = { ...sessionConfig, legacyModels: { ...sessionConfig.legacyModels, current: modelId } };
                    }
                } else {
                    return { ok: false, code: "unsupported", message: "This agent does not expose model selection." };
                }
                rememberThoughtDefault(true);
            }
            operation = "thought";
            const thought = sessionConfig.thoughtLevel;
            if (variant && !thought) {
                return { ok: false, code: "unsupported", message: "This model does not expose thinking-level selection." };
            }
            const target = variant ?? (modelId ? thoughtDefaults.get(modelId) : undefined)
                ?? explicitThoughtLevelReset(sessionConfig);
            if (thought && target && target !== thought.currentValue) {
                await setOption(thought.id, target);
            } else if (thought && variant === undefined && modelId !== undefined && !target) {
                return { ok: false, code: "unsupported", message: "This agent does not expose a native default thinking level to restore." };
            }
            return { ok: true };
        } catch (error) {
            if (methodMissing(error)) {
                if (operation === "model") modelSelectionUnavailable = true;
                return { ok: false, code: "unsupported", message: operation === "model"
                    ? "This agent does not expose model selection."
                    : "This agent does not expose thinking-level selection." };
            }
            return { ok: false, code: "native-failure", message: operation === "model"
                ? "The agent did not accept this model selection."
                : "The agent did not accept this thinking level." };
        }
    };
    const runtime: AgentRuntime = {
        capabilities: async () => ({
            streaming: true, permissions: true, questions: false, compaction: false, subagents: false,
            steering: false, usage: false, cost: false, fork: false, mcp: true,
            title: "native",
            attachments: { modalities: attachmentModalitySupport(agentCapabilities) },
            commands: { discovery: "native", invoke: "raw-native-input" },
            contextOccupancy: "unknown",
            resume: acpAdvertised(agentCapabilities?.sessionCapabilities?.resume)
                || agentCapabilities?.loadSession === true,
        }),
        commands: async () => [...nativeCommands],
        // Only what the agent advertised for this session. An agent that
        // exposes no model control reports an empty catalog, truthfully.
        models: async () => modelSelectionUnavailable ? [] : advertisedModels(),
        agents: async () => [],
        ensureSession: async (input) => {
            if (input.backendSessionId === nativeId && nativeId) return nativeId;
            if (!input.backendSessionId) {
                throw Object.assign(new Error("ACP v1 adapter requires fresh canonical continuity"), { code: "unknown-session" });
            }
            await resumeSession(input.backendSessionId);
            return nativeId;
        },
        createSessionOperation: create, resetSessionOperation: create,
        sessions: async () => Object.entries(rpc.receipts).map(([operationId, id]) => ({ id, operationId, title: lastTitle || "New session", createdAt: 0, updatedAt: 0 })), history: async () => [],
        async startTurnOperation(request, operationId) {
            if (!connected)
                return { kind: "unknown", operationId, message: "ACP runtime is disconnected and requires recovery" };
            if (active)
                return { kind: "rejected", code: "unsupported", message: "ACP adapter supports idle text turns" };
            const catalog: ModelDescriptor[] = modelSelectionUnavailable
                ? []
                : advertisedModels();
            if (request.model && (modelSelectionUnavailable || modelControl(sessionConfig).kind === "none")) {
                return { kind: "rejected", code: "unsupported", message: "This agent does not expose model selection." };
            }
            const selection = resolveModelSelection(catalog, request.model, harnessId);
            if (!selection.ok) return { kind: "rejected", code: selection.code, message: selection.message };
            const delivered = composeTurnPrompt(request.text, request.attachments);
            const prompt: Array<Record<string, unknown>> = [];
            const absolute = (path: string) => isAbsolute(path) ? path : join(context.cwd, path);
            const readBytes = (path: string) => readFile(absolute(path));
            if (delivered.images.length && agentCapabilities?.promptCapabilities?.image !== true) {
                return { kind: "rejected", code: "unsupported", message: unsupportedAttachmentMessage("image", descriptorName) };
            }
            for (const image of delivered.images) {
                try {
                    const data = await readBytes(image.localPath);
                    prompt.push({ type: "image", data: data.toString("base64"), mimeType: image.mime });
                } catch {
                    return { kind: "rejected", code: "invalid-attachment", message: "ACP image attachment could not be read" };
                }
            }
            for (const ref of request.attachments ?? []) {
                if (ref.kind === "browser-context") continue;
                const modality = attachmentModality(ref);
                if ((modality === "url" || /^https?:\/\//i.test(ref.url ?? "")) && ref.url) {
                    prompt.push({
                        type: "resource_link",
                        uri: ref.url,
                        name: ref.name,
                        ...(ref.mime ? { mimeType: ref.mime } : {}),
                    });
                    continue;
                }
                // A text file rides along as an embedded `resource` block only
                // when the agent advertises embeddedContext; otherwise the
                // server has already projected it into the prompt text.
                if (modality === "file" && agentCapabilities?.promptCapabilities?.embeddedContext === true) {
                    if (!ref.path) {
                        return { kind: "rejected", code: "invalid-attachment", message: `${ref.name} could not be read.` };
                    }
                    try {
                        const path = await confinedAttachmentPath(context.cwd, ref.path);
                        const data = await readBoundedTextSource(path);
                        const materialized = materializeAttachmentText({
                            path: ref.path,
                            ...(ref.kind === "range" && ref.range ? { range: ref.range } : {}),
                            bytes: data,
                        });
                        if (!materialized.ok) {
                            return { kind: "rejected", code: materialized.code, message: materialized.reason };
                        }
                        const resourceText = materialized.truncatedBytes > 0
                            ? `${materialized.content}\n[truncated ${materialized.truncatedBytes} bytes]`
                            : materialized.content;
                        prompt.push({
                            type: "resource",
                            resource: {
                                uri: pathToFileURL(path).href,
                                ...(ref.mime ? { mimeType: ref.mime } : {}),
                                text: resourceText,
                            },
                        });
                    } catch {
                        return { kind: "rejected", code: "invalid-attachment", message: `${ref.name} could not be read.` };
                    }
                    continue;
                }
                const contentType = modality === "image" ? "image" : modality === "audio" ? "audio" : undefined;
                if (!contentType) {
                    return { kind: "rejected", code: "unsupported", message: unsupportedAttachmentMessage(modality, descriptorName) };
                }
                if (agentCapabilities?.promptCapabilities?.[contentType] !== true) {
                    return { kind: "rejected", code: "unsupported", message: unsupportedAttachmentMessage(modality, descriptorName) };
                }
                if (!ref.path) {
                    return { kind: "rejected", code: "invalid-attachment", message: `${ref.name} could not be read.` };
                }
                try {
                    const data = await readBytes(ref.path);
                    prompt.push({ type: contentType, data: data.toString("base64"), mimeType: ref.mime });
                } catch {
                    return { kind: "rejected", code: "invalid-attachment", message: `${ref.name} could not be read.` };
                }
            }
            prompt.push({ type: "text", text: delivered.text });
            if (request.model) {
                const applied = await applySelection(request.model.modelID, selection.variant);
                if (!applied.ok) return { kind: "rejected", code: applied.code, message: applied.message };
                desiredModelId = request.model.modelID;
                desiredVariant = selection.variant;
            }
            active = true;
            turnId = operationId;
            text = "";
            messagePartId = "";
            messagePartOrdinal = 0;
            order++;
            return new Promise((resolve) => {
                resolveAdmission = resolve;
                touchPromptWatchdog();
                void rpc.request<{
                    stopReason: string;
                }>("session/prompt", { sessionId: nativeId, prompt }, 0).then((result) => {
                    if (!active || turnId !== operationId) return;
                    clearPromptWatchdog();
                    markAccepted();
                    finishMessagePart();
                    active = false;
                    order++;
                    emit({ type: "turn/stopped", turnId, reason: result.stopReason === "cancelled" ? "aborted" : "completed" });
                    for (const cb of lifecycle)
                        cb({ type: "stream-connected", authorityId: rpc.authorityId, generation: rpc.generation });
                }, (error) => {
                    if (!active || turnId !== operationId) return;
                    clearPromptWatchdog();
                    const rejected = (error as {
                        code?: string;
                    }).code === "runtime-rejected";
                    const pendingAdmission = resolveAdmission;
                    resolveAdmission = undefined;
                    if (pendingAdmission) {
                        pendingAdmission(rejected ? { kind: "rejected", code: "runtime-rejected", message: "ACP rejected the prompt" } : { kind: "unknown", operationId, message: "ACP response was lost" });
                    }
                    active = false;
                    order++;
                    // Once admission was observed, every failed prompt must
                    // close the canonical turn even when the native outcome is
                    // unknown. Before admission, the durable operation records
                    // rejection/uncertainty instead.
                    if (!pendingAdmission) {
                        emit({
                            type: "turn/stopped",
                            turnId,
                            reason: "error",
                            error: rejected ? "ACP rejected the prompt" : "ACP response was lost before a terminal result",
                            ...(!rejected ? { code: "unknown" as const } : {}),
                        });
                    }
                });
            });
        },
        startTurn: async () => { throw new Error("operation-aware admission required"); },
        async abort() { rpc.notify("session/cancel", { sessionId: nativeId }); for (const request of pending.values())
            request.resolve({ outcome: { outcome: "cancelled" } }); pending.clear(); },
        async abortOperation(_sid, operationId) { await runtime.abort(context.sessionId!); return { kind: "unknown", operationId, message: "ACP cancellation has no acknowledgement; waiting for the prompt result" }; },
        async replyPermission(_sid, requestId, reply) {
            const request = pending.get(requestId);
            if (!request)
                throw Object.assign(new Error("permission not found"), { code: "not-found" });
            const kind = reply === "reject" ? "reject_once" : reply === "always" ? "allow_always" : "allow_once";
            const option = request.options.find((option) => option.kind === kind);
            if (!option && reply !== "reject")
                throw Object.assign(new Error("The agent does not offer this permission choice"), { code: "runtime-rejected" });
            pending.delete(requestId);
            request.resolve(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } });
        },
        replyPermissionOperation: (_sid, requestId, reply, operationId) => mutate(operationId, async () => { await runtime.replyPermission(context.sessionId!, requestId, reply); return {}; }),
        replyQuestion: async () => { throw Object.assign(new Error("questions unsupported"), { code: "unsupported" }); },
        endpoint: async () => endpoint, protocol: async () => "legacy",
        reconcile: async (binding) => ({ ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
            state: { value: !connected || binding.backendSessionId !== nativeId ? "unknown" : active ? "running" : "idle", comparison: { domain: rpc.authorityId, order: ++order }, ...(createId && !accepted.length ? { causalOperationId: createId } : {}) },
            completeness: { events: "partial", permissions: connected ? "complete" : "unverifiable", questions: "complete" },
            events: [], permissions: [...pending].map(([requestId, p]) => ({ requestId, permission: p.permission, patterns: p.patterns })), questions: [], acceptedOperations: accepted,
        }),
        releaseExecution: (binding, operationId) => mutate(operationId, async () => { if ((binding.authorityId !== rpc.authorityId || binding.generation !== rpc.generation) && !rpc.releasedAuthorities.some((proof) => proof.authorityId === binding.authorityId && proof.generation === binding.generation))
            throw new Error("authority mismatch"); if (!binding.backendSessionId || binding.backendSessionId !== nativeId)
            throw Object.assign(new Error("release requires the native backend session"), { code: "unknown-session" }); await rpc.close(); return { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId }; }),
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        onLifecycle: (cb) => { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
        dispose: () => { clearPromptWatchdog(); return rpc.close(); },
    };
    return runtime;
}
