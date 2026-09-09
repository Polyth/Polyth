import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { AgentRuntime, CanonicalTurnRequest, HarnessContext, JsonObject, ModelDescriptor, ModelRef, MutationOutcome, RateLimitRetryHint, RuntimeErrorCode, RuntimeEvent, RuntimeObservation, RuntimeSnapshot, TokenUsage } from "@polyth/contracts";
import {
    acknowledgeCapabilityApplication,
    attachmentModality,
    captureCapabilityLaunch,
    composeTurnPrompt,
    contextWindowTelemetry,
    deltaTokenUsage,
    normalizeTokenUsage,
    provisioningTarget,
    releaseCapabilityLaunch,
    resolveModelSelection,
    unsupportedAttachmentMessage,
    type RpcPeer,
} from "@polyth/harness-runtime";
import { codexOverlays } from "./provisioner.ts";
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
        codexErrorInfo?: unknown;
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
const timestampMs = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0
        ? value < 1e12 ? value * 1000 : value
        : undefined;
const usageBreakdown = (value: unknown): TokenUsage | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    return normalizeTokenUsage({
        input: row.inputTokens,
        output: row.outputTokens,
        cacheRead: row.cachedInputTokens,
        cacheWrite: row.cacheWriteInputTokens,
        reasoning: row.reasoningOutputTokens,
    });
};
const classifyFailure = (
    turn: Turn,
    resetAt?: number,
): { error: string; code: RuntimeErrorCode; retry?: RateLimitRetryHint } => {
    const error = turn.error?.message?.trim() || "Codex turn failed";
    const info = turn.error?.codexErrorInfo;
    const kind = typeof info === "string"
        ? info
        : info && typeof info === "object" && !Array.isArray(info)
            ? String((info as { type?: unknown; kind?: unknown; code?: unknown }).type
                ?? (info as { kind?: unknown }).kind
                ?? (info as { code?: unknown }).code ?? "")
            : "";
    if (kind) {
        switch (kind) {
            case "Unauthorized":
                return { error, code: "auth-expired" };
            case "rate_limit":
            case "RateLimitExceeded":
                return { error, code: "rate-limited", retry: { scope: "rate", ...(resetAt ? { resetAt } : {}) } };
            case "UsageLimitExceeded":
                return { error, code: "quota-exhausted", retry: { scope: "quota", ...(resetAt ? { resetAt } : {}) } };
            case "ContextWindowExceeded":
            case "BadRequest":
            case "SandboxError":
            case "InternalServerError":
            case "Other":
                return { error, code: "unknown" };
            case "ResponseTooManyFailedAttempts":
            case "ResponseStreamDisconnected":
            case "ResponseStreamConnectionFailed":
            case "HttpConnectionFailed":
                return { error, code: "overloaded", retry: { scope: "overloaded" } };
            default:
                break;
        }
    }
    const structuredText = info === undefined ? "" : JSON.stringify(info).toLowerCase();
    const fallback = error.toLowerCase();
    const matches = (pattern: RegExp): boolean =>
        pattern.test(structuredText) || (!structuredText || !/auth|quota|rate|limit|overload|capacity/.test(structuredText)) && pattern.test(fallback);
    if (matches(/auth|unauthori[sz]ed|credential|token.?expired/)) {
        return { error, code: "auth-expired" };
    }
    if (matches(/quota|insufficient.?quota/)) {
        return { error, code: "quota-exhausted", retry: { scope: "quota", ...(resetAt ? { resetAt } : {}) } };
    }
    if (matches(/rate.?limit|too.?many.?requests/)) {
        return { error, code: "rate-limited", retry: { scope: "rate", ...(resetAt ? { resetAt } : {}) } };
    }
    if (matches(/overload|capacity|temporarily.?unavailable/)) {
        return { error, code: "overloaded", retry: { scope: "overloaded" } };
    }
    return { error, code: "unknown" };
};
const stopped = (turn: Turn, resetAt?: number): RuntimeEvent => {
    if (turn.status === "failed") {
        const failure = classifyFailure(turn, resetAt);
        return { type: "turn/stopped", turnId: turn.id, reason: "error", ...failure };
    }
    return {
        type: "turn/stopped",
        turnId: turn.id,
        reason: turn.status === "interrupted" ? "aborted" : "completed",
    };
};
export const CODEX_CAPABILITIES = {
    streaming: true, permissions: true, questions: false, compaction: true, subagents: false,
    steering: true, resume: true, usage: true, cost: false,
    // Polyth branchSession needs canonical history; Codex thread/fork copies native history only.
    fork: false as const,
    mcp: true,
    title: "native" as const,
    attachments: { modalities: {
        image: "native" as const,
        url: "native" as const,
        // App Server v2 input blocks carry text, localImage and image only, so
        // a text file is delivered by the server's prompt projection.
        file: "emulated" as const,
        pdf: "unsupported" as const,
        audio: "unsupported" as const,
    } },
    commands: { discovery: "unsupported" as const, invoke: "unsupported" as const },
    contextOccupancy: "native" as const,
};
export async function createCodexRuntime(context: HarnessContext, rpc: RpcPeer): Promise<AgentRuntime> {
    const sid = context.sessionId ?? "";
    let nativeId = "";
    let nativeModel: ModelRef | undefined;
    let activeTurn = "";
    let connected = true;
    let order = 0;
    let reconciliationOrdinal = 0;
    let lastRateLimitResetAt: number | undefined;
    let lastUsageCumulative: TokenUsage | undefined;
    let lastUsageDigest = "";
    let lastUsageTurnId = "";
    let sessionTitle = "Codex session";
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
        if (method === "account/rateLimits/updated") {
            const primary = params.rateLimits?.primary;
            const resetAt = timestampMs(primary?.resetsAt);
            if (resetAt) lastRateLimitResetAt = resetAt;
            return;
        }
        if (params.threadId !== nativeId)
            return;
        if (method === "thread/name/updated") {
            const title = typeof params.threadName === "string" ? params.threadName.trim() : "";
            if (title && !/^codex session$/i.test(title) && !/^new session/i.test(title)) {
                sessionTitle = title;
                emit({ type: "session/title-generated", title }, `${params.threadId}:title:${title}`);
            }
        }
        if (method === "thread/tokenUsage/updated") {
            const turnId = typeof params.turnId === "string" ? params.turnId : "";
            const cumulative = usageBreakdown(params.tokenUsage?.last);
            if (turnId && cumulative) {
                if (turnId !== lastUsageTurnId) {
                    lastUsageTurnId = turnId;
                    lastUsageCumulative = undefined;
                    lastUsageDigest = "";
                }
                const usageKey = `${turnId}:${digest(cumulative)}`;
                if (usageKey !== lastUsageDigest) {
                    lastUsageDigest = usageKey;
                    const rebased = lastUsageCumulative !== undefined && cumulative.input < lastUsageCumulative.input;
                    const tokens = rebased ? cumulative : deltaTokenUsage(lastUsageCumulative, cumulative);
                    lastUsageCumulative = cumulative;
                    emit({
                        type: "usage/recorded",
                        model: nativeModel ?? { providerID: "openai", modelID: "unknown" },
                        tokens,
                    }, `${usageKey}:usage`);
                }
            }
            const totalTokens = params.tokenUsage?.total?.totalTokens;
            const limitTokens = params.tokenUsage?.modelContextWindow;
            if (typeof totalTokens === "number" || typeof limitTokens === "number") {
                emit({ type: "context/updated", ...contextWindowTelemetry({
                    source: "native",
                    usedTokens: totalTokens,
                    limitTokens,
                }) }, `${turnId || params.threadId}:context`);
            }
        }
        if (method === "turn/started") {
            activeTurn = params.turn.id;
            emit({ type: "turn/started", turnId: activeTurn, ...(nativeModel ? { model: nativeModel } : {}) }, activeTurn + ":start");
        }
        if (method === "turn/completed") {
            activeTurn = "";
            lastUsageDigest = "";
            lastUsageTurnId = "";
            lastUsageCumulative = undefined;
            order++;
            const resetAt = lastRateLimitResetAt && lastRateLimitResetAt > Date.now()
                ? lastRateLimitResetAt
                : undefined;
            const event = stopped(params.turn, resetAt);
            if (event.type === "turn/stopped" && (event.code === "rate-limited" || event.code === "quota-exhausted")) {
                lastRateLimitResetAt = undefined;
            }
            emit(event, params.turn.id + ":stop");
        }
        if (method === "item/agentMessage/delta")
            emit({ type: "assistant/chunk", partId: params.itemId, text: params.delta }, params.itemId + ":chunk:" + (++order));
        if (method === "item/completed" || (method === "item/started" && params.item?.type !== "agentMessage")) {
            if (method === "item/completed" && params.item?.type === "contextCompaction") {
                emit({ type: "session/compacted" }, `${params.item.id}:compacted`);
                emit({
                    type: "context/updated",
                    source: "unknown",
                    updatedAt: Date.now(),
                    compaction: { active: false, lastAt: Date.now() },
                }, `${params.item.id}:context`);
            }
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
        if (rpc.receipts[operationId]) {
            nativeId = rpc.receipts[operationId]!;
            return {
                kind: "confirmed",
                value: { backendSessionId: nativeId },
                receipt: nativeId,
            };
        }
        if (input.model) {
            let available: ModelDescriptor[];
            try {
                available = await catalog();
            } catch {
                return {
                    kind: "rejected",
                    code: "discovery-unavailable",
                    message: "Codex could not verify the requested model before creating the session.",
                };
            }
            const selection = resolveModelSelection(available, input.model, "codex");
            if (!selection.ok) {
                return { kind: "rejected", code: selection.code, message: selection.message };
            }
        }
        const outcome = await mutate(operationId, async () => {
            const staged = codexOverlays.peek(context, "codex");
            const overlay = staged?.value;
            const config = overlay?.mcpServers ? { mcp_servers: overlay.mcpServers } : undefined;
            const launchTarget = provisioningTarget(context, "codex");
            if (staged) {
                captureCapabilityLaunch({
                    target: launchTarget,
                    desiredRevision: staged.desiredRevision,
                });
            }
            let result: { thread: Thread; model?: string; modelProvider?: string };
            try {
                result = await rpc.request<{ thread: Thread; model?: string; modelProvider?: string }>("thread/start", {
                    cwd: context.cwd,
                    approvalPolicy: "on-request",
                    sandbox: "workspace-write",
                    ...(overlay?.developerInstructions ? { developerInstructions: overlay.developerInstructions } : {}),
                    ...(config ? { config } : {}),
                    ...(input.model ? { model: input.model.modelID, modelProvider: input.model.providerID } : {}),
                });
                if (typeof result.thread?.id !== "string" || !result.thread.id)
                    throw new Error("Native thread receipt is invalid");
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
            const { thread } = result;
            if (result.model && result.modelProvider) nativeModel = { modelID: result.model, providerID: result.modelProvider };
            else if (input.model) nativeModel = input.model;
            nativeId = thread.id;
            if (staged) {
                codexOverlays.consumeIfRevision(context, "codex", staged.desiredRevision);
                acknowledgeCapabilityApplication({
                    target: provisioningTarget(context, "codex"),
                    desiredRevision: staged.desiredRevision,
                    capabilityIds: staged.capabilityIds,
                    outcome: "unverifiable",
                    reason: "Codex thread/start accepted the overlay; native application is unverifiable",
                });
            }
            await rpc.receipt(operationId, nativeId);
            return { backendSessionId: nativeId };
        });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: nativeId } : outcome;
    };
    // `model/list` is a cheap read on the already-open App Server connection,
    // but a turn asks for it to validate the reasoning effort, so one snapshot
    // per runtime (with in-flight dedupe) keeps sending free of extra RPCs.
    let modelCatalog: ModelDescriptor[] | undefined;
    let modelCatalogPending: Promise<ModelDescriptor[]> | undefined;
    const reasoningEfforts = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        return value.flatMap((entry) => {
            if (typeof entry === "string") return entry ? [entry] : [];
            const effort = (entry as { reasoningEffort?: unknown } | null)?.reasoningEffort;
            return typeof effort === "string" && effort ? [effort] : [];
        });
    };
    const catalog = (): Promise<ModelDescriptor[]> => {
        if (modelCatalog) return Promise.resolve(modelCatalog);
        if (modelCatalogPending) return modelCatalogPending;
        const pending = (async () => {
            type NativeModel = {
                    model: string;
                    displayName?: string;
                    hidden?: boolean;
                    inputModalities?: string[];
                    supportedReasoningEfforts?: unknown;
                    defaultReasoningEffort?: string;
            };
            const rows: NativeModel[] = [];
            const seenCursors = new Set<string>();
            let cursor: string | undefined;
            let pageCount = 0;
            while (true) {
                pageCount++;
                const response = await rpc.request<{
                    data?: NativeModel[];
                    nextCursor?: string | null;
                }>("model/list", cursor ? { cursor } : {});
                rows.push(...(response.data ?? []));
                const nextCursor = typeof response.nextCursor === "string" && response.nextCursor
                    ? response.nextCursor
                    : undefined;
                if (!nextCursor) break;
                if (pageCount >= 100) {
                    throw new Error("Codex model catalog exceeded the pagination limit");
                }
                if (seenCursors.has(nextCursor)) {
                    throw new Error("Codex model catalog returned a repeated pagination cursor");
                }
                seenCursors.add(nextCursor);
                cursor = nextCursor;
            }
            const seenModels = new Set<string>();
            const models = rows.filter((m) => !m.hidden).flatMap((m) => {
                const variants = reasoningEfforts(m.supportedReasoningEfforts);
                const defaultVariant = typeof m.defaultReasoningEffort === "string"
                    && variants.includes(m.defaultReasoningEffort)
                    ? m.defaultReasoningEffort
                    : undefined;
                const providerID = nativeModel?.providerID ?? "openai";
                const key = `${providerID}\0${m.model}`;
                if (seenModels.has(key)) return [];
                seenModels.add(key);
                return [{
                    // App Server v2 `model/list` carries no provider field; the
                    // provider is a property of the thread, so use the live one
                    // when the thread has reported it.
                    providerID,
                    modelID: m.model,
                    name: m.displayName || m.model,
                    connected: true,
                    capabilities: [
                        ...(m.inputModalities ?? []).flatMap((modality) => {
                            if (modality === "image") return ["input:image"];
                            if (modality === "text") return ["input:text"];
                            return [];
                        }),
                        "output:text",
                        "toolcall",
                    ],
                    ...(variants.length ? { variants } : {}),
                    ...(defaultVariant ? { defaultVariant } : {}),
                } satisfies ModelDescriptor];
            });
            modelCatalog = models;
            return models;
        })();
        modelCatalogPending = pending;
        return pending.finally(() => { if (modelCatalogPending === pending) modelCatalogPending = undefined; });
    };
    const start: NonNullable<AgentRuntime["startTurnOperation"]> = async (request: CanonicalTurnRequest, operationId: string) => {
        // `model/list` omits provider, so catalog normalization above supplies
        // the thread's canonical provider before strict generic validation.
        let selectedVariant: string | undefined;
        if (request.model) {
            let available: ModelDescriptor[];
            try {
                available = await catalog();
            } catch {
                return {
                    kind: "rejected",
                    code: "discovery-unavailable",
                    message: "Codex could not verify the available models for this session.",
                };
            }
            const selection = resolveModelSelection(available, request.model, "codex");
            if (!selection.ok) return { kind: "rejected", code: selection.code, message: selection.message };
            selectedVariant = selection.variant;
        }
        const delivered = composeTurnPrompt(request.text, request.attachments);
        const input: JsonObject[] = [{ type: "text", text: delivered.text }];
        for (const image of delivered.images) {
            input.push({ type: "localImage", path: image.localPath });
        }
        for (const ref of request.attachments ?? []) {
            if (ref.kind === "browser-context") continue;
            if ((ref.kind === "url" || /^https?:\/\//i.test(ref.url ?? "")) && ref.url) {
                input.push({ type: "image", url: ref.url });
                continue;
            }
            if (ref.mime?.startsWith("image/")) {
                if (!ref.path) {
                    return { kind: "rejected", code: "invalid-attachment", message: `${ref.name} could not be read as an image.` };
                }
                input.push({ type: "localImage", path: isAbsolute(ref.path) ? ref.path : join(context.cwd, ref.path) });
                continue;
            }
            // Text files are delivered by the server's prompt projection and
            // never reach this loop; anything else has no Codex input block.
            return {
                kind: "rejected",
                code: "unsupported",
                message: unsupportedAttachmentMessage(attachmentModality(ref), "Codex"),
            };
        }
        return mutate(operationId, async () => {
            if (request.model) nativeModel = request.model;
            const { turn } = await rpc.request<{
                turn: Turn;
            }>("turn/start", {
                threadId: nativeId,
                clientUserMessageId: operationId,
                input,
                ...(request.model ? { model: request.model.modelID } : {}),
                // Reasoning effort is per-turn in App Server v2 (`thread/start`
                // has no effort field). Omitting it keeps the native default.
                ...(selectedVariant ? { effort: selectedVariant } : {}),
            });
            if (typeof turn?.id !== "string" || !turn.id)
                throw new Error("Native turn receipt is invalid");
            activeTurn = turn.id;
            return { admissionId: turn.id };
        });
    };
    const runtime: AgentRuntime = {
        capabilities: async () => CODEX_CAPABILITIES,
        models: () => catalog(),
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
        sessions: async () => {
            if (nativeId) {
                try {
                    const thread = await read(nativeId);
                    if (thread.name) sessionTitle = thread.name;
                } catch {
                    // Receipt-backed listing keeps the last known title when read fails.
                }
            }
            return Object.entries(rpc.receipts).map(([operationId, id]) => ({
                operationId,
                id,
                title: sessionTitle,
                createdAt: 0,
                updatedAt: 0,
            }));
        },
        history: async () => (await read(nativeId)).turns?.flatMap((turn) => (turn.items ?? []).flatMap((item) => item.type === "agentMessage" && item.text ? [{ role: "assistant" as const, text: item.text }] : [])) ?? [],
        startTurnOperation: start,
        async startTurn(request) { const outcome = await start(request, randomUUID()); if (outcome.kind !== "confirmed")
            throw new Error("Codex turn was not confirmed"); },
        async abort() { if (activeTurn)
            await rpc.request("turn/interrupt", { threadId: nativeId, turnId: activeTurn }); },
        abortOperation: (_id, operationId) => mutate(operationId, async () => { await runtime.abort(sid); return {}; }),
        async steer(_id, text) {
            if (!activeTurn) return false;
            await rpc.request("turn/steer", {
                threadId: nativeId,
                expectedTurnId: activeTurn,
                input: [{ type: "text", text }],
            });
            return true;
        },
        steerOperation: (_id, text, operationId) => mutate(operationId, async () => {
            if (!activeTurn) throw Object.assign(new Error("No active Codex turn"), { code: "runtime-rejected" });
            await rpc.request("turn/steer", {
                threadId: nativeId,
                expectedTurnId: activeTurn,
                input: [{ type: "text", text }],
            });
            return {};
        }),
        async compact() {
            await rpc.request("thread/compact/start", { threadId: nativeId });
        },
        compactOperation: (_id, operationId) => mutate(operationId, async () => {
            await rpc.request("thread/compact/start", { threadId: nativeId });
            return {};
        }),
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
                    const event = stopped(turn, lastRateLimitResetAt);
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
