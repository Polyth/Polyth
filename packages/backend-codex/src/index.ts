import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentRuntime, CanonicalTurnRequest, HarnessCapabilityApplicationReceipt, HarnessContext, JsonObject, ModelDescriptor, ModelRef, MutationOutcome, RateLimitRetryHint, RuntimeErrorCode, RuntimeEvent, RuntimeObservation, RuntimeSnapshot, TokenUsage } from "@polyth/contracts";
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
import { listCodexMcpStatusRows, waitForCodexNativeMcp } from "./mcpReadiness.ts";
import { codexOverlays, type CodexLaunchOverlay, type CodexNativeMcp, type CodexNativeSkill } from "./provisioner.ts";
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
    server?: string;
    tool?: string;
    arguments?: unknown;
    result?: {
        content?: unknown[];
        structuredContent?: unknown;
    };
    error?: {
        message?: string;
    };
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
type CapabilityVerification = Pick<
    HarnessCapabilityApplicationReceipt,
    "capabilityIds" | "outcome" | "reason" | "evidence"
>;

const verifyNativeSkills = async (
    rpc: RpcPeer,
    cwd: string,
    root: string,
    expected: readonly CodexNativeSkill[],
): Promise<CapabilityVerification[]> => {
    try {
        await rpc.request("skills/extraRoots/set", { extraRoots: [root] });
        const response = await rpc.request<{
            data?: Array<{
                cwd?: string;
                skills?: Array<{ name?: string; path?: string; enabled?: boolean }>;
                errors?: Array<{ path?: string; message?: string }>;
            }>;
        }>("skills/list", { cwds: [cwd], forceReload: true });
        const entry = response.data?.find((item) =>
            typeof item.cwd === "string" && resolve(item.cwd) === resolve(cwd));
        if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) {
            return expected.map((skill) => ({
                capabilityIds: [skill.capabilityId],
                outcome: "failed",
                reason: "Codex returned malformed native skill discovery",
            }));
        }
        const discoveredSkills = entry.skills;
        const rootPath = resolve(root);
        const rootPrefix = `${rootPath}/`;
        const rootErrors = entry.errors.filter((error) =>
            typeof error.path === "string"
            && (resolve(error.path) === rootPath || resolve(error.path).startsWith(rootPrefix)));
        return expected.map((skill) => {
            const expectedPath = resolve(skill.path);
            const found = discoveredSkills.find((item) =>
                item.name === skill.name
                && typeof item.path === "string"
                && resolve(item.path) === expectedPath);
            const skillError = rootErrors.find((error) =>
                typeof error.path === "string"
                && (resolve(error.path) === expectedPath
                    || expectedPath.startsWith(`${resolve(error.path)}/`)
                    || resolve(error.path).startsWith(`${expectedPath}/`)));
            if (skillError) {
                return {
                    capabilityIds: [skill.capabilityId],
                    outcome: "failed" as const,
                    reason: "Codex reported an error for the staged native skill",
                    evidence: { stage: "discovered" as const, source: "skills/list(forceReload:true)" },
                };
            }
            if (!found) {
                return {
                    capabilityIds: [skill.capabilityId],
                    outcome: "failed" as const,
                    reason: "Codex did not discover the expected native skill name and path",
                    evidence: { stage: "discovered" as const, source: "skills/list(forceReload:true)" },
                };
            }
            if (found.enabled !== true) {
                return {
                    capabilityIds: [skill.capabilityId],
                    outcome: "failed" as const,
                    reason: "Codex discovered the native skill but reported it disabled",
                    evidence: { stage: "discovered" as const, source: "skills/list(forceReload:true)" },
                };
            }
            return {
                capabilityIds: [skill.capabilityId],
                outcome: "applied" as const,
                reason: "Codex discovered the expected enabled native skill",
                evidence: { stage: "discovered" as const, source: "skills/list(forceReload:true)" },
            };
        });
    } catch {
        return expected.map((skill) => ({
            capabilityIds: [skill.capabilityId],
            outcome: "failed",
            reason: "Codex native skill discovery failed",
        }));
    }
};

const buildThreadConfig = (overlay: CodexLaunchOverlay | undefined): JsonObject | undefined => {
    if (!overlay?.mcpServers) return undefined;
    return {
        mcp_servers: overlay.mcpServers,
        // Optional MCP omitted from the first model tool catalog after 1s by default;
        // wait the full startup_timeout_sec instead so package tools are present.
        mcp_optional_startup_grace_ms: 0,
    };
};

const formatMcpToolOutput = (result: Item["result"]): string => {
    if (!result) return "";
    if (Array.isArray(result.content)) {
        return result.content.flatMap((entry) => {
            if (entry && typeof entry === "object" && !Array.isArray(entry)) {
                const row = entry as { type?: string; text?: string };
                if (row.type === "text" && typeof row.text === "string") return [row.text];
            }
            return [JSON.stringify(entry)];
        }).join("\n");
    }
    if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
    return "";
};

const verifyNativeMcp = async (
    rpc: RpcPeer,
    threadId: string,
    expected: readonly CodexNativeMcp[],
): Promise<CapabilityVerification[]> => {
    try {
        const rows = await listCodexMcpStatusRows(rpc, threadId);
        return expected.map((server) => {
            const found = rows.find((row) => row.name === server.name);
            if (!found) {
                return [{
                    capabilityIds: [server.capabilityId, ...server.tools.map((tool) => tool.capabilityId)],
                    outcome: "failed" as const,
                    reason: "Codex did not discover the expected native MCP server",
                    evidence: { stage: "discovered" as const, source: "mcpServerStatus/list" },
                }];
            }
            const toolReceipts: CapabilityVerification[] = server.tools.map((tool) => {
                const discovered = Object.values(found.tools ?? {}).some((candidate) => candidate.name === tool.name);
                return discovered ? {
                    capabilityIds: [tool.capabilityId],
                    outcome: "unverifiable",
                    reason: "Codex discovered the native MCP tool; direct invocation was not exercised",
                    evidence: { stage: "discovered", source: "mcpServerStatus/list" },
                } : {
                    capabilityIds: [tool.capabilityId],
                    outcome: "failed",
                    reason: "Codex did not discover the expected native MCP tool",
                    evidence: { stage: "discovered", source: "mcpServerStatus/list" },
                };
            });
            if (found.runtimeStatus === "connected") {
                return [{
                    capabilityIds: [server.capabilityId],
                    outcome: "applied" as const,
                    reason: "Codex reports the native MCP server connected; tool invocation was not exercised",
                    evidence: { stage: "connected" as const, source: "mcpServerStatus/list" },
                }, ...toolReceipts];
            }
            if (found.runtimeStatus === "failed"
                || found.runtimeStatus === "authenticationRequired"
                || found.runtimeStatus === "cancelled"
                || found.runtimeStatus === "disabled") {
                return [{
                    capabilityIds: [server.capabilityId],
                    outcome: "failed" as const,
                    reason: `Codex reports the native MCP server ${found.runtimeStatus}`,
                    evidence: { stage: "discovered" as const, source: "mcpServerStatus/list" },
                }, ...toolReceipts];
            }
            return [{
                capabilityIds: [server.capabilityId],
                outcome: "unverifiable" as const,
                reason: `Codex discovered the native MCP server but reports ${found.runtimeStatus ?? "no runtime status"}`,
                evidence: { stage: "discovered" as const, source: "mcpServerStatus/list" },
            }, ...toolReceipts];
        }).flat();
    } catch {
        return expected.map((server) => ({
            capabilityIds: [server.capabilityId, ...server.tools.map((tool) => tool.capabilityId)],
            outcome: "unverifiable",
            reason: "Codex accepted the MCP launch configuration but native status could not be read",
            evidence: { stage: "staged", source: "thread/start config.mcp_servers" },
        }));
    }
};
const eventFor = (item: Item): RuntimeEvent | undefined => {
    if (item.type === "agentMessage" && typeof item.text === "string") return { type: "assistant/message", partId: item.id, text: item.text };
    if (item.type === "mcpToolCall" && typeof item.tool === "string") {
        const input = {
            ...(item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
                ? item.arguments as JsonObject
                : {}),
            ...(item.server ? { server: item.server } : {}),
        };
        if (item.status === "inProgress") return { type: "tool/started", callId: item.id, tool: item.tool, input };
        if (item.status === "failed") {
            return {
                type: "tool/error",
                callId: item.id,
                tool: item.tool,
                error: item.error?.message?.trim() || "MCP tool call failed",
                input,
            };
        }
        if (item.status === "completed") {
            return {
                type: "tool/result",
                callId: item.id,
                tool: item.tool,
                output: formatMcpToolOutput(item.result),
                input,
            };
        }
        return undefined;
    }
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
const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
type CodexFailure = { error: string; code: RuntimeErrorCode; retry?: RateLimitRetryHint };
type RateLimitWindow = { resetsAt?: unknown; usedPercent?: unknown };
type RateLimitSnapshot = {
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
    individualLimit?: { remainingPercent?: unknown; resetsAt?: unknown } | null;
    rateLimitReachedType?: string | null;
};
const CODEX_LIMIT_PROVIDER = "openai";
const limitRetry = (scope: RateLimitRetryHint["scope"], resetAt?: number): RateLimitRetryHint => ({
    scope,
    provider: CODEX_LIMIT_PROVIDER,
    ...(resetAt ? { resetAt } : {}),
});
const rateLimitWindows = (snapshot: RateLimitSnapshot): Array<{ usedPercent: number; resetAt?: number }> => {
    const rows: Array<{ usedPercent: number; resetAt?: number }> = [];
    for (const window of [snapshot.primary, snapshot.secondary]) {
        if (!isRecord(window)) continue;
        rows.push({
            usedPercent: typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
                ? window.usedPercent
                : 0,
            resetAt: timestampMs(window.resetsAt),
        });
    }
    if (isRecord(snapshot.individualLimit)) {
        const remaining = snapshot.individualLimit.remainingPercent;
        rows.push({
            usedPercent: typeof remaining === "number" && Number.isFinite(remaining)
                ? Math.max(0, 100 - remaining)
                : 0,
            resetAt: timestampMs(snapshot.individualLimit.resetsAt),
        });
    }
    return rows;
};
/** Wait until every exhausted Codex window has reset; otherwise the soonest future reset. */
const resetAtFromSnapshot = (snapshot: RateLimitSnapshot | undefined, now: number): number | undefined => {
    if (!snapshot) return undefined;
    const future = rateLimitWindows(snapshot).filter((row): row is { usedPercent: number; resetAt: number } =>
        typeof row.resetAt === "number" && row.resetAt > now);
    const exhausted = future.filter((row) => row.usedPercent >= 100);
    if (exhausted.length) return Math.max(...exhausted.map((row) => row.resetAt));
    if (future.length) return Math.min(...future.map((row) => row.resetAt));
    return undefined;
};
const reachedTypeFailure = (snapshot: RateLimitSnapshot | undefined, error: string, resetAt?: number): CodexFailure | undefined => {
    const reached = snapshot?.rateLimitReachedType;
    if (typeof reached !== "string" || !reached) return undefined;
    if (reached === "rate_limit_reached") {
        return { error, code: "rate-limited", retry: limitRetry("rate", resetAt) };
    }
    if (reached.includes("usage_limit") || reached.includes("credits_depleted")) {
        return { error, code: "quota-exhausted", retry: limitRetry("quota", resetAt) };
    }
    return undefined;
};
const errorKind = (info: unknown): string => {
    if (typeof info === "string") return info;
    if (!isRecord(info)) return "";
    const named = info.type ?? info.kind ?? info.code;
    if (typeof named === "string" && named) return named;
    const [first] = Object.keys(info);
    return first ?? "";
};
const kindKey = (kind: string): string => kind.replace(/[_-]/g, "").toLowerCase();
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
): CodexFailure => {
    const error = turn.error?.message?.trim() || "Codex turn failed";
    const info = turn.error?.codexErrorInfo;
    const kind = errorKind(info);
    if (kind) {
        switch (kindKey(kind)) {
            case "unauthorized":
                return { error, code: "auth-expired" };
            case "ratelimit":
            case "ratelimitexceeded":
                return { error, code: "rate-limited", retry: limitRetry("rate", resetAt) };
            case "usagelimitexceeded":
            case "sessionbudgetexceeded":
                return { error, code: "quota-exhausted", retry: limitRetry("quota", resetAt) };
            case "contextwindowexceeded":
            case "badrequest":
            case "sandboxerror":
            case "internalservererror":
            case "other":
            case "cyberpolicy":
            case "misalignmentpolicyviolation":
            case "threadrollbackfailed":
            case "activeturnnotsteerable":
                return { error, code: "unknown" };
            case "serveroverloaded":
            case "responsetoomanyfailedattempts":
            case "responsestreamdisconnected":
            case "responsestreamconnectionfailed":
            case "httpconnectionfailed":
                return { error, code: "overloaded", retry: limitRetry("overloaded") };
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
    if (matches(/quota|insufficient.?quota|usage.?limit/)) {
        return { error, code: "quota-exhausted", retry: limitRetry("quota", resetAt) };
    }
    if (matches(/rate.?limit|too.?many.?requests/)) {
        return { error, code: "rate-limited", retry: limitRetry("rate", resetAt) };
    }
    if (matches(/overload|capacity|temporarily.?unavailable/)) {
        return { error, code: "overloaded", retry: limitRetry("overloaded") };
    }
    return { error, code: "unknown" };
};
const withReset = (failure: CodexFailure, resetAt?: number): CodexFailure => {
    if (!failure.retry || !resetAt || failure.retry.resetAt) return failure;
    return { ...failure, retry: { ...failure.retry, resetAt } };
};
const stopped = (
    turn: Turn,
    resetAt?: number,
    snapshot?: RateLimitSnapshot,
    pending?: CodexFailure,
): RuntimeEvent => {
    if (turn.status === "failed") {
        let failure = classifyFailure(turn, resetAt);
        if (failure.code === "unknown" && pending && pending.code !== "unknown") {
            failure = withReset({ ...pending, error: failure.error }, resetAt);
        }
        if (failure.code === "unknown") {
            const reached = reachedTypeFailure(snapshot, failure.error, resetAt);
            if (reached) failure = reached;
        }
        failure = withReset(failure, resetAt);
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
    // App Server reports names set on a thread, but it does not promise to
    // generate a semantic title for a new thread. Let the canonical session
    // layer persist its prompt-derived fallback without waiting on a native
    // event that may never arrive; an actual name update can still refine it.
    title: "emulated" as const,
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
    let lastRateLimits: RateLimitSnapshot | undefined;
    let pendingFailure: { turnId: string; failure: CodexFailure } | undefined;
    let lastUsageCumulative: TokenUsage | undefined;
    let lastUsageDigest = "";
    let lastUsageTurnId = "";
    // Empty means "no native name yet": the canonical layer treats it as a
    // placeholder, so the restored native-title poll never persists a generic
    // default before Codex publishes its semantic thread name.
    let sessionTitle = "";
    let nativeMcpReady = false;
    let requiredNativeMcp: readonly CodexNativeMcp[] = [];
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
            if (isRecord(params.rateLimits)) lastRateLimits = params.rateLimits as RateLimitSnapshot;
            return;
        }
        if (params.threadId !== nativeId)
            return;
        if (method === "error") {
            const resetAt = resetAtFromSnapshot(lastRateLimits, Date.now());
            const turnId = typeof params.turnId === "string" ? params.turnId : "";
            pendingFailure = {
                turnId,
                failure: classifyFailure({
                    id: turnId,
                    status: "failed",
                    error: isRecord(params.error) ? params.error as Turn["error"] : { message: String(params.error ?? "") },
                }, resetAt),
            };
            return;
        }
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
            // `total` is lifetime thread usage and can legitimately exceed a
            // model window after several turns. `last` is the current model
            // request/response footprint used by Codex for window occupancy.
            const occupiedTokens = params.tokenUsage?.last?.totalTokens;
            const limitTokens = params.tokenUsage?.modelContextWindow;
            if (typeof occupiedTokens === "number" || typeof limitTokens === "number") {
                emit({ type: "context/updated", ...contextWindowTelemetry({
                    source: "native",
                    usedTokens: occupiedTokens,
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
            const resetAt = resetAtFromSnapshot(lastRateLimits, Date.now());
            const pending = pendingFailure && pendingFailure.turnId === params.turn.id
                ? pendingFailure.failure
                : undefined;
            const event = stopped(params.turn, resetAt, lastRateLimits, pending);
            pendingFailure = undefined;
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
            const code = (error as { code?: string }).code;
            if (code === "runtime-rejected") {
                return { kind: "rejected", code: "runtime-rejected", message: "Codex rejected the request" };
            }
            if (code === "native-failure") {
                return {
                    kind: "rejected",
                    code: "native-failure",
                    message: error instanceof Error ? error.message : "Codex native bridge failed",
                };
            }
            return { kind: "unknown", operationId, message: "Codex did not confirm the request" };
        }
    };
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (input, operationId) => {
        if (rpc.receipts[operationId]) {
            nativeId = rpc.receipts[operationId]!;
            nativeMcpReady = true;
            requiredNativeMcp = [];
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
            const config = buildThreadConfig(overlay);
            requiredNativeMcp = overlay?.nativeMcp ?? [];
            nativeMcpReady = requiredNativeMcp.length === 0;
            const launchTarget = provisioningTarget(context, "codex");
            if (staged) {
                captureCapabilityLaunch({
                    target: launchTarget,
                    desiredRevision: staged.desiredRevision,
                });
            }
            const skillVerification = overlay?.nativeSkills
                ? await verifyNativeSkills(
                    rpc,
                    context.cwd,
                    overlay.nativeSkills.root,
                    overlay.nativeSkills.skills,
                )
                : [];
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
            try {
                if (requiredNativeMcp.length) {
                    await waitForCodexNativeMcp(rpc, nativeId, requiredNativeMcp);
                    nativeMcpReady = true;
                }
            } catch (error) {
                if (staged) {
                    releaseCapabilityLaunch({
                        target: launchTarget,
                        desiredRevision: staged.desiredRevision,
                    });
                }
                throw error;
            }
            await rpc.receipt(operationId, nativeId);
            if (staged) {
                codexOverlays.consumeIfRevision(context, "codex", staged.desiredRevision);
                const mcpVerification = overlay?.nativeMcp
                    ? await verifyNativeMcp(rpc, nativeId, overlay.nativeMcp)
                    : [];
                const stagedCapabilityIds = overlay?.stagedCapabilityIds
                    ?? (!overlay?.nativeSkills && !overlay?.nativeMcp ? staged.capabilityIds : []);
                const verification: CapabilityVerification[] = [
                    ...(stagedCapabilityIds.length ? [{
                        capabilityIds: stagedCapabilityIds,
                        outcome: "unverifiable" as const,
                        reason: "Codex thread/start accepted the staged capability without authoritative readback",
                        evidence: { stage: "staged" as const, source: "thread/start" },
                    }] : []),
                    ...skillVerification,
                    ...mcpVerification,
                ];
                for (const receipt of verification) {
                    acknowledgeCapabilityApplication({
                        target: launchTarget,
                        desiredRevision: staged.desiredRevision,
                        ...receipt,
                    });
                }
            }
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
        if (requiredNativeMcp.length && !nativeMcpReady) {
            return {
                kind: "rejected",
                code: "native-failure",
                message: "Codex cannot admit a turn before the Polyth agent-tools bridge is ready.",
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
    const canSteer = (model?: ModelRef, agent?: string) => !agent && (!model || !!nativeModel
        && model.providerID === nativeModel.providerID
        && model.modelID === nativeModel.modelID
        && model.variant === nativeModel.variant);
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
        async steer(_id, text, model, agent) {
            if (!activeTurn || !canSteer(model, agent)) return false;
            await rpc.request("turn/steer", {
                threadId: nativeId,
                expectedTurnId: activeTurn,
                input: [{ type: "text", text }],
            });
            return true;
        },
        steerOperation: (_id, text, operationId, model, agent) => mutate(operationId, async () => {
            if (!activeTurn || !canSteer(model, agent)) throw Object.assign(new Error("Codex cannot apply the requested live steering selection"), { code: "runtime-rejected" });
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
                        events.push({ entityKey: item.id, revision: digest(event), events: [event] });
                }
                if (turn.status !== "inProgress") {
                    const event = stopped(
                        turn,
                        resetAtFromSnapshot(lastRateLimits, Date.now()),
                        lastRateLimits,
                        pendingFailure && pendingFailure.turnId === turn.id
                            ? pendingFailure.failure
                            : undefined,
                    );
                    events.push({ entityKey: turn.id + ":stop", revision: digest(event), events: [event] });
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
