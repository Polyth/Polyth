import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntime, HarnessContext, JsonObject, ModelRef, MutationOutcome, RuntimeEvent, RuntimeObservation, RuntimeSnapshot } from "@polyth/contracts";
import { createProcessAuthority } from "@polyth/harness-runtime";
import type { SDKUserMessage, Query, PermissionResult, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
type Sdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query" | "getSessionInfo">;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** The SDK owns its protocol; Polyth owns the SDK's native child process and
 * records only public dialogue/tool outcomes. It never consumes thinking. */
export async function createClaudeRuntime(context: HarnessContext, sdk: Sdk, authority: Awaited<ReturnType<typeof createProcessAuthority>>): Promise<AgentRuntime> {
    let query: Query | undefined;
    let nativeId = "";
    let active = "";
    let nativeModel: ModelRef | undefined;
    let connected = true;
    let order = 0;
    let createId = "";
    let reconciliationOrdinal = 0;
    let wake: (() => void) | undefined;
    const inputs: SDKUserMessage[] = [];
    let admission: (() => void) | undefined;
    const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
    const events: RuntimeSnapshot["events"] = [];
    const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
    const observations = new Set<(sid: string, event: RuntimeObservation) => void>();
    const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
    const permissions = new Map<string, {
        resolve(result: PermissionResult): void;
        input: Record<string, unknown>;
        tool: string;
    }>();
    const endpoint = { authorityId: authority.authorityId, generation: authority.generation, continuity: "generation-only" as const, url: "sdk:", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: authority.authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
    const emit = (event: RuntimeEvent, key: string) => {
        const revision = digest(event);
        events.push({ entityKey: key, revision, event });
        const artifactKind = event.type.startsWith("tool/") ? "tool" : event.type.startsWith("turn/") ? "turn" : event.type === "permission/requested" ? "permission" : "message";
        if (observations.size && reconciliationOrdinal > 0)
            for (const cb of observations)
                cb(context.sessionId!, { channel: "sse", entityKey: key, identity: { ...endpoint, backendSessionId: nativeId, artifactKind, entityId: key, revision }, reconciliationOrdinal, events: [event] });
        else
            for (const cb of listeners)
                cb(context.sessionId!, event);
    };
    const markAccepted = () => { if (admission) {
        const done = admission;
        admission = undefined;
        accepted.push({ operationId: active, mutationKind: "turn-submit", receipt: active });
        emit({ type: "turn/started", turnId: active, ...(nativeModel ? { model: nativeModel } : {}) }, active + ":start");
        done();
    } };
    async function* prompts(): AsyncGenerator<SDKUserMessage> { while (connected) {
        if (!inputs.length)
            await new Promise<void>(resolve => { wake = resolve; });
        while (inputs.length)
            yield inputs.shift()!;
    } }
    const initialize = async (id: string, resume = false) => {
        if (query) {
            if (nativeId !== id)
                throw Object.assign(new Error("Fresh native session requires a released process"), { code: "unsupported" });
            return;
        }
        nativeId = id;
        query = sdk.query({ prompt: prompts(), options: { cwd: context.cwd, ...(resume ? { resume: id } : { sessionId: id }), pathToClaudeCodeExecutable: process.env.POLYTH_CLAUDE_BIN ?? "claude", permissionMode: "default", includePartialMessages: false,
                // Parallel subagents are not yet represented by this adapter.
                disallowedTools: ["Agent", "Task", "AskUserQuestion"],
                spawnClaudeCodeProcess(options) { const child = authority.spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal }); child.stderr!.resume(); return child as SpawnedProcess; },
                canUseTool: async (tool, input, options) => {
                    markAccepted();
                    const requestId = (options as {
                        toolUseID?: string;
                    }).toolUseID ?? randomUUID();
                    return new Promise<PermissionResult>(resolve => { permissions.set(requestId, { resolve, input, tool }); emit({ type: "permission/requested", requestId, permission: tool, patterns: [String(input.command ?? input.file_path ?? tool)] }, requestId); options.signal.addEventListener("abort", () => { permissions.delete(requestId); resolve({ behavior: "deny", message: "Cancelled" }); }, { once: true }); });
                },
            } });
        await query.initializationResult();
        void (async () => {
            try {
                for await (const message of query!) {
                    if ("parent_tool_use_id" in message && message.parent_tool_use_id)
                        continue;
                    if (message.type === "system" && message.subtype === "init") nativeModel = { providerID: "anthropic", modelID: message.model };
                    if (message.type === "assistant") {
                        if (message.message.model) nativeModel = { providerID: "anthropic", modelID: message.message.model };
                        markAccepted();
                        const body = message.message.content;
                        for (let i = 0; i < body.length; i++) {
                            const block = body[i]!;
                            const key = `${message.uuid}:${i}`;
                            if (block.type === "text")
                                emit({ type: "assistant/message", partId: key, text: block.text }, key);
                            if (block.type === "tool_use")
                                emit({ type: "tool/started", callId: block.id, tool: block.name, input: block.input as JsonObject }, block.id + ":start");
                        }
                    }
                    if (message.type === "user" && Array.isArray(message.message.content))
                        for (const block of message.message.content) {
                            if (block.type === "tool_result")
                                emit(block.is_error ? { type: "tool/error", callId: block.tool_use_id, tool: "tool", error: "Tool failed" } : { type: "tool/result", callId: block.tool_use_id, tool: "tool", output: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? []) }, block.tool_use_id + ":result");
                        }
                    if (message.type === "result") {
                        markAccepted();
                        const turnId = active;
                        active = "";
                        order++;
                        emit({ type: "turn/stopped", turnId, reason: message.is_error ? "error" : "completed", ...(message.is_error ? { error: "Claude Code turn failed" } : {}) }, turnId + ":stop");
                    }
                }
            }
            catch {
                connected = false;
                wake?.();
                for (const cb of lifecycle)
                    cb({ type: "stream-disconnected", authorityId: authority.authorityId, generation: authority.generation });
            }
        })();
    };
    const mutate = async <T>(operationId: string, action: () => Promise<T>): Promise<MutationOutcome<T>> => { try {
        return { kind: "confirmed", value: await action() };
    }
    catch {
        return { kind: "unknown", operationId, message: "Claude Code did not confirm the operation" };
    } };
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (_request, operationId) => {
        const outcome = await mutate(operationId, async () => { const id = authority.receipts[operationId] ?? randomUUID(); await initialize(id); createId = operationId; await authority.receipt(operationId, id); return { backendSessionId: id }; });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: outcome.value.backendSessionId } : outcome;
    };
    const runtime: AgentRuntime = {
        capabilities: async () => ({ streaming: false, permissions: true, questions: false, compaction: false, subagents: false, steering: false, resume: false, usage: false, cost: false, fork: false, mcp: true }),
        models: async () => query ? (await query.supportedModels()).map(m => ({ providerID: "anthropic", modelID: m.value, name: m.displayName, connected: true })) : [], agents: async () => [],
        createSessionOperation: create, resetSessionOperation: create,
        async ensureSession(input) { if (!input.backendSessionId)
            throw Object.assign(new Error("Operation-aware creation required"), { code: "unsupported" }); const info = await sdk.getSessionInfo(input.backendSessionId, { dir: context.cwd }); await initialize(input.backendSessionId, Boolean(info)); return nativeId; },
        sessions: async () => Object.entries(authority.receipts).map(([operationId, id]) => ({ id, operationId, title: "Claude Code session", createdAt: 0, updatedAt: 0 })), history: async () => [],
        async startTurnOperation(request, operationId) {
            if (!query || active || request.attachments?.length || (request.model && request.model.providerID !== "anthropic"))
                return { kind: "rejected", code: "unsupported", message: "Claude Code supports idle text turns on its native account" };
            if (request.model)
                await query.setModel(request.model.modelID);
            active = operationId;
            order++;
            return new Promise(resolve => { admission = () => resolve({ kind: "confirmed", value: { admissionId: operationId }, receipt: operationId }); inputs.push({ type: "user", uuid: operationId as SDKUserMessage["uuid"], session_id: nativeId, parent_tool_use_id: null, message: { role: "user", content: request.text } }); wake?.(); });
        },
        startTurn: async () => { throw new Error("Operation-aware admission required"); },
        abort: async () => { await query?.interrupt(); },
        abortOperation: (_id, operationId) => mutate(operationId, async () => { await query?.interrupt(); return {}; }),
        async replyPermission(_id, requestId, reply) { const request = permissions.get(requestId); if (!request)
            throw Object.assign(new Error("Permission no longer pending"), { code: "not-found" }); permissions.delete(requestId); request.resolve(reply === "reject" ? { behavior: "deny", message: "User declined" } : { behavior: "allow", updatedInput: request.input }); },
        replyPermissionOperation: (_id, requestId, reply, operationId) => mutate(operationId, async () => { await runtime.replyPermission(context.sessionId!, requestId, reply); return {}; }),
        replyQuestion: async () => { throw Object.assign(new Error("Questions unsupported"), { code: "unsupported" }); },
        endpoint: async () => endpoint, protocol: async () => "legacy",
        reconcile: async (binding) => { reconciliationOrdinal = binding.reconciliationOrdinal ?? 0; return ({ ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0, state: { value: !connected || nativeId !== binding.backendSessionId ? "unknown" : active ? "running" : "idle", comparison: { domain: authority.authorityId, order: ++order }, ...(createId && !accepted.length ? { causalOperationId: createId } : {}) }, completeness: { events: "partial", permissions: connected ? "complete" : "unverifiable", questions: "complete" }, events, permissions: [...permissions].map(([requestId, p]) => ({ requestId, permission: p.tool, patterns: [p.tool] })), questions: [], acceptedOperations: accepted }); },
        releaseExecution: (binding, operationId) => mutate(operationId, async () => { if ((binding.authorityId !== authority.authorityId || binding.generation !== authority.generation) && !authority.releasedAuthorities.some(p => p.authorityId === binding.authorityId && p.generation === binding.generation))
            throw new Error("Authority mismatch"); await runtime.dispose(); return { authorityId: binding.authorityId, generation: binding.generation }; }),
        onEvent: cb => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; }, onObservation: cb => { observations.add(cb); return { dispose: () => { observations.delete(cb); } }; }, onLifecycle: cb => { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
        async dispose() { connected = false; wake?.(); await authority.close(); query?.close(); },
    };
    return runtime;
}
