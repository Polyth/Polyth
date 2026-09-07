import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntime, CanonicalTurnRequest, HarnessContext, JsonObject, ModelRef, MutationOutcome, RuntimeEvent, RuntimeObservation, RuntimeSnapshot } from "@polyth/contracts";
import type { RpcPeer } from "@polyth/harness-runtime";
// These are the small provider-local fields used from App Server v2. The
// installed CLI can generate its full schema; it is not a core Polyth contract.
type Item = {
    type: string;
    id: string;
    text?: string;
    clientId?: string;
    content?: Array<{
        type: string;
        text?: string;
    }>;
    command?: string;
    aggregatedOutput?: string;
    status?: string;
    changes?: unknown[];
};
type Turn = {
    id: string;
    status: string;
    itemsView?: string;
    items?: Item[];
    error?: {
        message?: string;
    };
};
type Thread = {
    historyMode?: string;
    source?: string;
    id: string;
    cwd: string;
    name?: string;
    preview?: string;
    updatedAt?: number;
    createdAt?: number;
    status?: {
        type: string;
    };
    turns?: Turn[];
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventFor = (item: Item): RuntimeEvent | undefined => {
    if (item.type === "agentMessage" && typeof item.text === "string") return { type: "assistant/message", partId: item.id, text: item.text };
    if (item.type === "commandExecution") {
        const input = { command: item.command ?? "" };
        if (item.status === "inProgress") return { type: "tool/started", callId: item.id, tool: "shell", input };
        if (item.status === "failed" || item.status === "declined") return { type: "tool/error", callId: item.id, tool: "shell", error: "Command did not complete successfully", input };
        return { type: "tool/result", callId: item.id, tool: "shell", output: item.aggregatedOutput ?? "", input };
    }
    if (item.type === "fileChange" && item.status !== "inProgress") {
        const input = { changes: (item.changes ?? []) as JsonObject[] };
        return item.status === "completed"
            ? { type: "tool/result", callId: item.id, tool: "edit", output: "File changes applied", input }
            : { type: "tool/error", callId: item.id, tool: "edit", error: "File changes were not confirmed", input };
    }
    // Reasoning, hook prompts and provider system instructions are excluded.
    return undefined;
};
const stopped = (turn: Turn): RuntimeEvent => ({ type: "turn/stopped", turnId: turn.id, reason: turn.status === "failed" ? "error" : turn.status === "interrupted" ? "aborted" : "completed", ...(turn.status === "failed" ? { error: "Codex turn failed" } : {}) });
export async function createCodexRuntime(context: HarnessContext, rpc: RpcPeer): Promise<AgentRuntime> {
    const sid = context.sessionId ?? "";
    let nativeId = "";
    let nativeModel: ModelRef | undefined;
    let activeTurn = "";
    let connected = true;
    let order = 0;
    let reconciliationOrdinal = 0;
    const listeners = new Set<(id: string, event: RuntimeEvent) => void>();
    const observations = new Set<(id: string, event: RuntimeObservation) => void>();
    const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
    const pending = new Map<string, {
        resolve(result: unknown): void;
        permission: string;
        patterns: string[];
    }>();
    const endpoint = { authorityId: rpc.authorityId, generation: rpc.generation, continuity: "verified" as const, url: "stdio:", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: rpc.authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
    const emit = (event: RuntimeEvent, key: string, revision = digest(event)) => {
        if (observations.size && reconciliationOrdinal > 0) {
            const artifactKind = event.type.startsWith("tool/") ? "tool" : event.type.startsWith("turn/") ? "turn" : event.type === "permission/requested" ? "permission" : event.type === "assistant/chunk" ? "part" : "message";
            for (const cb of observations)
                cb(sid, { channel: "sse", entityKey: key, identity: { ...endpoint, backendSessionId: nativeId, artifactKind, entityId: key, revision }, reconciliationOrdinal, events: [event] });
        }
        else
            for (const cb of listeners)
                cb(sid, event);
    };
    const read = async (threadId: string) => (await rpc.request<{
        thread: Thread;
    }>("thread/read", { threadId, includeTurns: true })).thread;
    rpc.onClose(() => { connected = false; for (const cb of lifecycle)
        cb({ type: "stream-disconnected", authorityId: endpoint.authorityId, generation: endpoint.generation }); });
    rpc.onNotification((method, params) => {
        if (params.threadId !== nativeId)
            return;
        if (method === "turn/started") {
            activeTurn = params.turn.id;
            emit({ type: "turn/started", turnId: activeTurn, ...(nativeModel ? { model: nativeModel } : {}) }, activeTurn + ":start");
        }
        if (method === "turn/completed") {
            activeTurn = "";
            order++;
            emit(stopped(params.turn), params.turn.id + ":stop");
        }
        if (method === "item/agentMessage/delta")
            emit({ type: "assistant/chunk", partId: params.itemId, text: params.delta }, params.itemId + ":chunk:" + (++order));
        if (method === "item/completed" || (method === "item/started" && params.item?.type !== "agentMessage")) {
            const event = eventFor(params.item);
            if (event)
                emit(event, params.item.id);
        }
    });
    rpc.onRequest(async (method, params) => {
        if (params.threadId !== nativeId)
            throw new Error("unbound native thread");
        if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval")
            throw new Error("unsupported request");
        const requestId = String(params.itemId);
        const permission = method.includes("commandExecution") ? "bash" : "edit";
        const patterns = [String(params.command ?? params.reason ?? "Workspace changes")];
        return new Promise((resolve) => { pending.set(requestId, { resolve, permission, patterns }); emit({ type: "permission/requested", requestId, permission, patterns }, requestId, "pending"); });
    });
    const mutate = async <T>(operationId: string, action: () => Promise<T>): Promise<MutationOutcome<T>> => {
        try {
            return { kind: "confirmed", value: await action() };
        }
        catch (error) {
            return (error as {
                code?: string;
            }).code === "runtime-rejected" ? { kind: "rejected", code: "runtime-rejected", message: "Codex rejected the request" } : { kind: "unknown", operationId, message: "Codex did not confirm the request" };
        }
    };
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (input, operationId) => {
        const outcome = await mutate(operationId, async () => {
            if (rpc.receipts[operationId]) {
                nativeId = rpc.receipts[operationId]!;
                return { backendSessionId: nativeId };
            }
            const result = await rpc.request<{ thread: Thread; model?: string; modelProvider?: string }>("thread/start", { cwd: context.cwd, approvalPolicy: "on-request", sandbox: "workspace-write", ...(input.model ? { model: input.model.modelID, modelProvider: input.model.providerID } : {}) });
            const { thread } = result;
            if (result.model && result.modelProvider) nativeModel = { modelID: result.model, providerID: result.modelProvider };
            if (typeof thread?.id !== "string" || !thread.id)
                throw new Error("Native thread receipt is invalid");
            nativeId = thread.id;
            await rpc.receipt(operationId, nativeId);
            return { backendSessionId: nativeId };
        });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: nativeId } : outcome;
    };
    const start: NonNullable<AgentRuntime["startTurnOperation"]> = (request: CanonicalTurnRequest, operationId: string) => {
        if (request.model && request.model.providerID !== (nativeModel?.providerID ?? "openai"))
            return Promise.resolve({ kind: "rejected", code: "unsupported", message: "Select a model from the Codex native route" });
        if (request.attachments?.length)
            return Promise.resolve({ kind: "rejected", code: "unsupported", message: "Codex attachment translation is not implemented" });
        return mutate(operationId, async () => {
            if (request.model) nativeModel = request.model;
            const { turn } = await rpc.request<{
                turn: Turn;
            }>("turn/start", { threadId: nativeId, clientUserMessageId: operationId, input: [{ type: "text", text: request.text, text_elements: [] }], ...(request.model ? { model: request.model.modelID } : {}) });
            if (typeof turn?.id !== "string" || !turn.id)
                throw new Error("Native turn receipt is invalid");
            activeTurn = turn.id;
            return { admissionId: turn.id };
        });
    };
    const runtime: AgentRuntime = {
        capabilities: async () => ({ streaming: true, permissions: true, questions: false, compaction: false, subagents: false, steering: false, resume: true, usage: false, cost: false, fork: false, mcp: true }),
        models: async () => (await rpc.request<{
            data: Array<{
                model: string;
                displayName: string;
                hidden?: boolean;
            }>;
        }>("model/list", {})).data.filter((m) => !m.hidden).map((m) => ({ providerID: nativeModel?.providerID ?? "openai", modelID: m.model, name: m.displayName, connected: true })),
        agents: async () => [],
        async ensureSession(input) {
            if (!input.backendSessionId)
                throw Object.assign(new Error("operation-aware creation required"), { code: "unsupported" });
            if (nativeId !== input.backendSessionId) {
                const resumed = await rpc.request<{ model?: string; modelProvider?: string }>("thread/resume", { threadId: input.backendSessionId, cwd: context.cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
                if (resumed.model && resumed.modelProvider) nativeModel = { modelID: resumed.model, providerID: resumed.modelProvider };
                nativeId = input.backendSessionId;
            }
            return nativeId;
        },
        createSessionOperation: create, resetSessionOperation: create,
        sessions: async () => Object.entries(rpc.receipts).map(([operationId, id]) => ({ operationId, id, title: "Codex session", createdAt: 0, updatedAt: 0 })),
        history: async () => (await read(nativeId)).turns?.flatMap((turn) => (turn.items ?? []).flatMap((item) => item.type === "agentMessage" && item.text ? [{ role: "assistant" as const, text: item.text }] : [])) ?? [],
        startTurnOperation: start,
        async startTurn(request) { const outcome = await start(request, randomUUID()); if (outcome.kind !== "confirmed")
            throw new Error("Codex turn was not confirmed"); },
        async abort() { if (activeTurn)
            await rpc.request("turn/interrupt", { threadId: nativeId, turnId: activeTurn }); },
        abortOperation: (_id, operationId) => mutate(operationId, async () => { await runtime.abort(sid); return {}; }),
        async replyPermission(_id, requestId, reply) { const request = pending.get(requestId); if (!request)
            throw Object.assign(new Error("permission is no longer pending"), { code: "not-found" }); pending.delete(requestId); request.resolve({ decision: reply === "reject" ? "decline" : reply === "always" ? "acceptForSession" : "accept" }); },
        replyPermissionOperation: (_id, requestId, reply, operationId) => mutate(operationId, async () => { await runtime.replyPermission(sid, requestId, reply); return {}; }),
        replyQuestion: async () => { throw Object.assign(new Error("questions unsupported"), { code: "unsupported" }); },
        endpoint: async () => endpoint, protocol: async () => "legacy",
        async reconcile(binding) {
            reconciliationOrdinal = binding.reconciliationOrdinal ?? 0;
            const events: RuntimeSnapshot["events"] = [];
            const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
            const thread = connected ? await read(binding.backendSessionId!) : undefined;
            for (const turn of thread?.turns ?? []) {
                for (const item of turn.items ?? []) {
                    if (item.type === "userMessage" && item.clientId)
                        accepted.push({ operationId: item.clientId, mutationKind: "turn-submit", receipt: turn.id });
                    if (item.type === "agentMessage" && turn.status === "inProgress")
                        continue;
                    const event = eventFor(item);
                    if (event)
                        events.push({ entityKey: item.id, revision: digest(event), event });
                }
                if (turn.status !== "inProgress") {
                    const event = stopped(turn);
                    events.push({ entityKey: turn.id + ":stop", revision: digest(event), event });
                }
            }
            const createEntry = Object.entries(rpc.receipts).find(([, id]) => id === binding.backendSessionId);
            const historyComplete = thread && thread.historyMode !== "paginated" && thread.turns?.every((turn) => turn.itemsView === undefined || turn.itemsView === "full");
            const running = thread?.status?.type === "active" || thread?.turns?.some((turn) => turn.status === "inProgress");
            return { ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0,
                state: { value: !thread || thread.status?.type === "systemError" || thread.status?.type === "notLoaded" ? "unknown" : running ? "running" : "idle", comparison: { domain: endpoint.authorityId + ":" + endpoint.generation, order: ++order }, ...(createEntry && !thread?.turns?.length ? { causalOperationId: createEntry[0] } : {}) },
                completeness: { events: historyComplete ? "complete" : thread ? "partial" : "unverifiable", permissions: connected ? "complete" : "unverifiable", questions: "complete" }, events,
                permissions: [...pending].map(([requestId, p]) => ({ requestId, permission: p.permission, patterns: p.patterns, revision: "pending" })), questions: [], acceptedOperations: accepted,
            };
        },
        releaseExecution: (binding, operationId) => mutate(operationId, async () => { if ((binding.authorityId !== endpoint.authorityId || binding.generation !== endpoint.generation) && !rpc.releasedAuthorities.some((proof) => proof.authorityId === binding.authorityId && proof.generation === binding.generation))
            throw new Error("authority mismatch"); if (!binding.backendSessionId || binding.backendSessionId !== nativeId)
            throw Object.assign(new Error("release requires the native backend session"), { code: "unknown-session" }); await rpc.close(); return { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId }; }),
        onEvent: (cb) => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; },
        onObservation: (cb) => { observations.add(cb); return { dispose: () => { observations.delete(cb); } }; },
        onLifecycle: (cb) => { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
        dispose: () => rpc.close(),
    };
    return runtime;
}
export type { Thread };
