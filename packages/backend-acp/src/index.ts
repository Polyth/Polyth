export { registerAcpProfile } from "./profile.ts";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, HarnessContext, HarnessDescriptor, HarnessProvider, JsonObject, MutationOutcome, RuntimeEvent, RuntimeSnapshot } from "@polyth/contracts";
import { createStdioRpc, type RpcPeer } from "@polyth/harness-runtime";
export interface AcpProfile {
    descriptor: HarnessDescriptor;
    command: string;
    args: string[];
    /** Verified native authentication check; never read credential files. */
    probe: HarnessProvider["probe"];
}
/** ACP v1 is deliberately version-pinned. V2 changes prompt admission and
 * session lifecycle; it must not be guessed from a superficially similar API. */
export async function connectAcp(profile: AcpProfile, context: HarnessContext, stateFile?: string): Promise<RpcPeer> {
    const rpc = await createStdioRpc({ command: profile.command, args: profile.args, cwd: context.cwd, stateFile });
    try {
        const result = await rpc.request<{
            protocolVersion: number;
        }>("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "polyth", version: "0.1.0" } });
        if (result.protocolVersion !== 1)
            throw new Error("unsupported ACP version");
        return rpc;
    }
    catch (error) {
        await rpc.close();
        throw error;
    }
}
export function createAcpRuntime(context: HarnessContext, rpc: RpcPeer): AgentRuntime {
    let nativeId = "";
    let active = false;
    let connected = true;
    let order = 0;
    let createId = "";
    let turnId = "";
    let text = "";
    let admit: (() => void) | undefined;
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
        if (method !== "session/update" || params.sessionId !== nativeId || !active)
            return;
        const update = params.update;
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
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (_input, operationId) => {
        const outcome = await mutate(operationId, async () => {
            const result = await rpc.request<{
                sessionId: string;
            }>("session/new", { cwd: context.cwd, mcpServers: [] });
            if (typeof result?.sessionId !== "string" || !result.sessionId)
                throw new Error("Native session receipt is invalid");
            nativeId = result.sessionId;
            createId = operationId;
            await rpc.receipt(operationId, nativeId);
            return { backendSessionId: nativeId };
        });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: nativeId } : outcome;
    };
    const runtime: AgentRuntime = {
        capabilities: async () => ({ streaming: true, permissions: true, questions: false, compaction: false, subagents: false, steering: false, resume: false, usage: false, cost: false, fork: false, mcp: false }),
        models: async () => [], agents: async () => [],
        ensureSession: async (input) => { if (input.backendSessionId !== nativeId || !nativeId)
            throw Object.assign(new Error("ACP v1 adapter requires fresh canonical continuity"), { code: "unknown-session" }); return nativeId; },
        createSessionOperation: create, resetSessionOperation: create,
        sessions: async () => Object.entries(rpc.receipts).map(([operationId, id]) => ({ id, operationId, title: "ACP session", createdAt: 0, updatedAt: 0 })), history: async () => [],
        async startTurnOperation(request, operationId) {
            if (active || request.attachments?.length || request.model)
                return { kind: "rejected", code: "unsupported", message: "ACP adapter supports idle text turns with the agent's native model" };
            active = true;
            turnId = operationId;
            text = "";
            order++;
            return new Promise((resolve) => {
                admit = () => resolve({ kind: "confirmed", value: { admissionId: operationId }, receipt: operationId });
                void rpc.request<{
                    stopReason: string;
                }>("session/prompt", { sessionId: nativeId, prompt: [{ type: "text", text: request.text }] }, 0).then((result) => {
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
            throw new Error("authority mismatch"); await rpc.close(); return { authorityId: binding.authorityId, generation: binding.generation }; }),
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        onLifecycle: (cb) => { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
        dispose: () => rpc.close(),
    };
    return runtime;
}
