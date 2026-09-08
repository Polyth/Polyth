export { registerAcpProfile } from "./profile.ts";
export { createAcpProvisioner } from "./provisioner.ts";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentRuntime, HarnessContext, HarnessDescriptor, HarnessProvider, JsonObject, MutationOutcome, RuntimeCommandDescriptor, RuntimeEvent, RuntimeSnapshot } from "@polyth/contracts";
import {
    acknowledgeCapabilityApplication,
    captureCapabilityLaunch,
    composeTurnPrompt,
    createStdioRpc,
    provisioningTarget,
    releaseCapabilityLaunch,
    type RpcPeer,
} from "@polyth/harness-runtime";
import { acpOverlays, type AcpLaunchOverlay } from "./provisioner.ts";
export interface AcpProfile {
    descriptor: HarnessDescriptor;
    command: string;
    args: string[];
    /** Verified native authentication check; never read credential files. */
    probe: HarnessProvider["probe"];
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
        embeddedContext?: boolean;
    };
}

/** ACP sessionCapabilities.resume is an empty object when present. */
const acpAdvertised = (value: unknown): boolean =>
    value === true || (typeof value === "object" && value !== null);

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
    attachments: { modalities: {
        image: "unsupported" as const,
        audio: "unsupported" as const,
        file: "unsupported" as const,
        pdf: "unsupported" as const,
        url: "unsupported" as const,
    } },
    commands: { discovery: "native" as const, invoke: "raw-native-input" as const },
    contextOccupancy: "unknown" as const,
    resume: false,
};
export interface AcpConnection {
    rpc: RpcPeer;
    agentCapabilities?: AcpAgentCapabilities;
}
/** ACP v1 is deliberately version-pinned. V2 changes prompt admission and
 * session lifecycle; it must not be guessed from a superficially similar API. */
export async function connectAcp(profile: AcpProfile, context: HarnessContext, stateFile?: string): Promise<AcpConnection> {
    const rpc = await createStdioRpc({ command: profile.command, args: profile.args, cwd: context.cwd, stateFile });
    try {
        const result = await rpc.request<{
            protocolVersion: number;
            agentCapabilities?: AcpAgentCapabilities;
        }>("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "polyth", version: "0.1.0" } });
        if (result.protocolVersion !== 1)
            throw new Error("unsupported ACP version");
        return { rpc, agentCapabilities: result.agentCapabilities };
    }
    catch (error) {
        await rpc.close();
        throw error;
    }
}
export function createAcpRuntime(
    context: HarnessContext,
    rpc: RpcPeer,
    harnessId = "acp",
    agentCapabilities?: AcpAgentCapabilities,
): AgentRuntime {
    let nativeId = "";
    let active = false;
    let connected = true;
    let order = 0;
    let createId = "";
    let turnId = "";
    let text = "";
    let admit: (() => void) | undefined;
    let lastTitle = "";
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
    const markAccepted = () => { if (admit) {
        const done = admit;
        admit = undefined;
        accepted.push({ operationId: turnId, mutationKind: "turn-submit", receipt: turnId });
        emit({ type: "turn/started", turnId });
        done();
    } };
    rpc.onClose(() => { connected = false; for (const cb of lifecycle)
        cb({ type: "stream-disconnected", authorityId: rpc.authorityId, generation: rpc.generation }); });
    rpc.onNotification((method, params) => {
        if (method !== "session/update" || params.sessionId !== nativeId)
            return;
        const update = params.update;
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
                emit({
                    type: "context/updated",
                    source: "native",
                    updatedAt: Date.now(),
                    ...(usedTokens !== undefined ? { usedTokens } : {}),
                    ...(limitTokens !== undefined ? { limitTokens } : {}),
                    ...(usedTokens !== undefined && limitTokens !== undefined
                        ? {
                            remainingTokens: Math.max(0, limitTokens - usedTokens),
                            fraction: limitTokens > 0 ? usedTokens / limitTokens : undefined,
                        }
                        : {}),
                });
            }
            return;
        }
        if (!active) return;
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            markAccepted();
            text += update.content.text;
            emit({ type: "assistant/chunk", partId: turnId, text: update.content.text });
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            markAccepted();
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
        await withLaunchOverlay(async (overlay) => {
            await rpc.request(canResume ? "session/resume" : "session/load", {
                sessionId: backendSessionId,
                cwd: context.cwd,
                mcpServers: overlay?.mcpServers ?? [],
            });
        }, canResume
            ? "ACP session/resume accepted mcpServers; native model load is unverifiable"
            : "ACP session/load accepted mcpServers; native model load is unverifiable");
        nativeId = backendSessionId;
    };
    const runtime: AgentRuntime = {
        capabilities: async () => ({
            streaming: true, permissions: true, questions: false, compaction: false, subagents: false,
            steering: false, usage: false, cost: false, fork: false, mcp: true,
            title: "native",
            attachments: { modalities: {
                image: agentCapabilities?.promptCapabilities?.image === true ? "native" : "unsupported",
                audio: agentCapabilities?.promptCapabilities?.audio === true ? "native" : "unsupported",
                file: "unsupported",
                pdf: "unsupported",
                url: "unsupported",
            } },
            commands: { discovery: "native", invoke: "raw-native-input" },
            contextOccupancy: "unknown",
            resume: acpAdvertised(agentCapabilities?.sessionCapabilities?.resume)
                || agentCapabilities?.loadSession === true,
        }),
        commands: async () => [...nativeCommands],
        models: async () => [], agents: async () => [],
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
            if (active || request.model)
                return { kind: "rejected", code: "unsupported", message: "ACP adapter supports idle text turns with the agent's native model" };
            const delivered = composeTurnPrompt(request.text, request.attachments);
            const prompt: Array<Record<string, unknown>> = [];
            const readBytes = (path: string) => readFile(isAbsolute(path) ? path : join(context.cwd, path));
            if (delivered.images.length && agentCapabilities?.promptCapabilities?.image !== true) {
                return { kind: "rejected", code: "unsupported", message: "This ACP agent does not advertise image prompts" };
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
                const contentType = ref.mime?.startsWith("image/")
                    ? "image"
                    : ref.mime?.startsWith("audio/") ? "audio" : undefined;
                if (!contentType) {
                    return { kind: "rejected", code: "unsupported", message: "ACP supports only advertised image and audio attachments" };
                }
                if (agentCapabilities?.promptCapabilities?.[contentType] !== true) {
                    return { kind: "rejected", code: "unsupported", message: `This ACP agent does not advertise ${contentType} prompts` };
                }
                if (!ref.path) {
                    return { kind: "rejected", code: "invalid-attachment", message: `ACP ${contentType} attachment requires a materialized path` };
                }
                try {
                    const data = await readBytes(ref.path);
                    prompt.push({ type: contentType, data: data.toString("base64"), mimeType: ref.mime });
                } catch {
                    return { kind: "rejected", code: "invalid-attachment", message: `ACP ${contentType} attachment could not be read` };
                }
            }
            prompt.push({ type: "text", text: delivered.text });
            active = true;
            turnId = operationId;
            text = "";
            order++;
            return new Promise((resolve) => {
                admit = () => resolve({ kind: "confirmed", value: { admissionId: operationId }, receipt: operationId });
                void rpc.request<{
                    stopReason: string;
                }>("session/prompt", { sessionId: nativeId, prompt }, 0).then((result) => {
                    markAccepted();
                    if (text)
                        emit({ type: "assistant/message", partId: turnId, text });
                    active = false;
                    order++;
                    emit({ type: "turn/stopped", turnId, reason: result.stopReason === "cancelled" ? "aborted" : "completed" });
                    for (const cb of lifecycle)
                        cb({ type: "stream-connected", authorityId: rpc.authorityId, generation: rpc.generation });
                }, (error) => {
                    const rejected = (error as {
                        code?: string;
                    }).code === "runtime-rejected";
                    if (admit) {
                        admit = undefined;
                        resolve(rejected ? { kind: "rejected", code: "runtime-rejected", message: "ACP rejected the prompt" } : { kind: "unknown", operationId, message: "ACP response was lost" });
                    }
                    // Loss of the channel never invents a stopped turn.
                    if (rejected) {
                        active = false;
                        order++;
                        emit({ type: "turn/stopped", turnId, reason: "error", error: "ACP rejected the prompt" });
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
        dispose: () => rpc.close(),
    };
    return runtime;
}
