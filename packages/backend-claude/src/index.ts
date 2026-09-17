import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentRuntime, HarnessContext, JsonObject, ModelDescriptor, ModelRef, MutationOutcome, RateLimitRetryHint, RuntimeCommandDescriptor, RuntimeEvent, RuntimeObservation, RuntimeSnapshot, TokenUsage } from "@polyth/contracts";
import { attachmentModality, composeTurnPrompt, contextWindowTelemetry, createProcessAuthority, deltaCost, deltaTokenUsage, isPlaceholderTitle, normalizeTokenUsage, resolveModelSelection, unsupportedAttachmentMessage } from "@polyth/harness-runtime";
import type { EffortLevel, SDKUserMessage, Query, PermissionResult, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
    acknowledgeCapabilityApplication,
    captureCapabilityLaunch,
    provisioningTarget,
    releaseCapabilityLaunch,
} from "@polyth/harness-runtime";
import { claudeAuthFingerprint, claudeModelDescriptors, discoverClaudeModels, invalidateClaudeModelCache, peekClaudeModels } from "./discovery.ts";
import { claudeOverlays } from "./provisioner.ts";
export { claudeOverlays, createClaudeProvisioner } from "./provisioner.ts";
export { claudeAuthFingerprint, claudeModelDescriptors, discoverClaudeModels, invalidateClaudeModelCache } from "./discovery.ts";
type Sdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query" | "getSessionInfo">;
const claudeExecutable = (): string => process.env.POLYTH_CLAUDE_BIN ?? "claude";
export const CLAUDE_CAPABILITIES = {
    streaming: true, permissions: true, questions: false, compaction: false, subagents: false,
    steering: false, resume: true, usage: true, cost: true, fork: false, mcp: true,
    title: "native" as const,
    attachments: { modalities: {
        image: "native" as const,
        pdf: "native" as const,
        // The SDK's user content blocks cover image and document (PDF) only, so
        // a text file is delivered by the server's prompt projection.
        file: "emulated" as const,
        audio: "unsupported" as const,
        url: "unsupported" as const,
    } },
    commands: { discovery: "native" as const, invoke: "raw-native-input" as const },
    contextOccupancy: "native" as const,
};
const usageFromModelUsage = (usage: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>): TokenUsage => {
    let input = 0; let output = 0; let cacheRead = 0; let cacheWrite = 0;
    for (const row of Object.values(usage)) {
        input += row.inputTokens ?? 0;
        output += row.outputTokens ?? 0;
        cacheRead += row.cacheReadInputTokens ?? 0;
        cacheWrite += row.cacheCreationInputTokens ?? 0;
    }
    return normalizeTokenUsage({ input, output, cacheRead, cacheWrite });
};
const toNativeCommands = (commands: Array<{ name: string; description?: string; argumentHint?: string }>): RuntimeCommandDescriptor[] =>
    commands.map((cmd) => ({
        id: `native:claude:${cmd.name}`,
        name: cmd.name,
        ...(cmd.description ? { description: cmd.description } : {}),
        ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint, acceptsArguments: true } : {}),
        owner: "native",
        harnessId: "claude",
        invocation: "raw-native-input",
        availability: "session",
    }));
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
    let lastUsage: TokenUsage | undefined;
    let lastCost: number | undefined;
    let lastResultId = "";
    let lastContextResultId = "";
    let lastTitle = "";
    let pendingRetry: RateLimitRetryHint | undefined;
    let streamMessageOrdinal = -1;
    let streamEventOrdinal = 0;
    const streamPartIds = new Map<number, string>();
    const nativeCommands: RuntimeCommandDescriptor[] = [];
    const permissions = new Map<string, {
        resolve(result: PermissionResult): void;
        input: Record<string, unknown>;
        tool: string;
    }>();
    const endpoint = { authorityId: authority.authorityId, generation: authority.generation, continuity: "generation-only" as const, url: "sdk:", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: authority.authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
    const emit = (event: RuntimeEvent, key: string) => {
        const revision = digest(event);
        const artifactKind = event.type.startsWith("tool/") ? "tool" : event.type.startsWith("turn/") ? "turn" : event.type === "permission/requested" ? "permission" : "message";
        // Live and pull must claim one durable entity: the snapshot carries the
        // same artifact kind the observation below publishes.
        events.push({ entityKey: key, revision, artifactKind, events: [event] });
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
    const streamPartId = (index: number): string => {
        const existing = streamPartIds.get(index);
        if (existing) return existing;
        const ordinal = Math.max(0, streamMessageOrdinal);
        const partId = `${active}:stream:${ordinal}:${index}`;
        streamPartIds.set(index, partId);
        return partId;
    };
    async function* prompts(): AsyncGenerator<SDKUserMessage> { while (connected) {
        if (!inputs.length)
            await new Promise<void>(resolve => { wake = resolve; });
        while (inputs.length)
            yield inputs.shift()!;
    } }
    // Effort is a session-level flag in the Agent SDK: set once at query
    // creation, then changed live with applyFlagSettings. `null` means "no
    // effort parameter", i.e. the model's own default.
    let appliedEffort: string | null | undefined;
    const initialize = async (id: string, resume = false, model?: string, effort?: string) => {
        if (query) {
            if (nativeId !== id)
                throw Object.assign(new Error("Fresh native session requires a released process"), { code: "unsupported" });
            return;
        }
        nativeId = id;
        const staged = claudeOverlays.peek(context, "claude");
        const overlay = staged?.value;
        const launchTarget = provisioningTarget(context, "claude");
        if (staged) {
            captureCapabilityLaunch({
                target: launchTarget,
                desiredRevision: staged.desiredRevision,
            });
        }
        let initialization!: Awaited<ReturnType<Query["initializationResult"]>>;
        try {
            query = sdk.query({ prompt: prompts(), options: { cwd: context.cwd, ...(resume ? { resume: id } : { sessionId: id }), pathToClaudeCodeExecutable: claudeExecutable(), permissionMode: "default", includePartialMessages: true,
                    ...(effort ? { effort: effort as EffortLevel } : {}),
                    ...(model ? { model } : {}),
                    // Parallel subagents are not yet represented by this adapter.
                    disallowedTools: ["Agent", "Task"],
                    ...(overlay?.append ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: overlay.append } } : {}),
                    ...(overlay?.mcpServers ? { mcpServers: overlay.mcpServers } : {}),
                    ...(overlay?.plugins ? { plugins: overlay.plugins } : {}),
                    pluginDelivery: "initialize",
                    // An explicit allowlist prevents unrelated user/global
                    // skills from entering this Space-private native session.
                    skills: overlay?.skills ?? [],
                    spawnClaudeCodeProcess(options) { const child = authority.spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal }); child.stderr!.resume(); return child as SpawnedProcess; },
                    canUseTool: async (tool, input, options) => {
                        markAccepted();
                        const requestId = (options as {
                            toolUseID?: string;
                        }).toolUseID ?? randomUUID();
                        return new Promise<PermissionResult>(resolve => { permissions.set(requestId, { resolve, input, tool }); emit({ type: "permission/requested", requestId, permission: tool, patterns: [String(input.command ?? input.file_path ?? tool)] }, requestId); options.signal.addEventListener("abort", () => { permissions.delete(requestId); resolve({ behavior: "deny", message: "Cancelled" }); }, { once: true }); });
                    },
                } });
            initialization = await query.initializationResult();
            if (effort) appliedEffort = effort;
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
        if (staged) {
            const verification = overlay?.verification;
            const commandsResult = verification?.skills.length && typeof query.supportedCommands === "function"
                ? await query.supportedCommands().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: [] }))
                : { ok: true as const, value: [] };
            if (commandsResult.ok) {
                nativeCommands.splice(0, nativeCommands.length, ...toNativeCommands(commandsResult.value));
            }
            const mcpResult = verification && (verification.mcpServers.length || verification.tools.length) && typeof query.mcpServerStatus === "function"
                ? await query.mcpServerStatus().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: [] }))
                : { ok: !(verification && (verification.mcpServers.length || verification.tools.length)), value: [] };
            const receipt = (
                capabilityId: string,
                outcome: "applied" | "unverifiable" | "failed",
                reason: string,
                evidence: { stage: "staged" | "discovered" | "connected" | "invocable"; source: string },
            ) => acknowledgeCapabilityApplication({
                target: provisioningTarget(context, "claude", { authorityId: authority.authorityId, generation: authority.generation }),
                desiredRevision: staged.desiredRevision,
                capabilityIds: [capabilityId],
                outcome,
                reason,
                evidence,
            });
            for (const capabilityId of verification?.promptIds ?? []) {
                receipt(capabilityId, "unverifiable", "Claude Agent SDK accepted the launch prompt; native application has no readback", {
                    stage: "staged", source: "Claude SDK launch options",
                });
            }
            for (const skill of verification?.skills ?? []) {
                if (initialization.plugins_applied !== true) {
                    receipt(
                        skill.capabilityId,
                        initialization.plugins_applied === false ? "failed" : "unverifiable",
                        initialization.plugins_applied === false
                            ? "Claude reported that the Space-private plugin was not applied"
                            : "Claude did not report whether the Space-private plugin was applied",
                        { stage: "staged", source: "initializationResult.plugins_applied" },
                    );
                    continue;
                }
                const discovered = commandsResult.value.some((command) => command.name === skill.canonicalName);
                receipt(
                    skill.capabilityId,
                    discovered ? "applied" : commandsResult.ok ? "failed" : "unverifiable",
                    discovered
                        ? "Claude loaded and discovered the exact Space-private skill"
                        : commandsResult.ok
                            ? "Claude loaded the plugin but did not discover the exact skill"
                            : "Claude loaded the plugin but command discovery was unavailable",
                    { stage: discovered ? "discovered" : "staged", source: discovered ? "supportedCommands exact canonical name" : "initializationResult.plugins_applied" },
                );
            }
            for (const server of verification?.mcpServers ?? []) {
                const status = mcpResult.value.find((candidate) => candidate.name === server.name);
                if (!server.enabled) {
                    const absent = mcpResult.ok && (!status || status.status === "disabled");
                    receipt(
                        server.capabilityId,
                        absent ? "applied" : mcpResult.ok ? "failed" : "unverifiable",
                        absent ? "Claude confirmed the retired MCP server is absent" : "Claude still reports the retired MCP server",
                        { stage: mcpResult.ok ? "discovered" : "staged", source: "mcpServerStatus" },
                    );
                } else if (status?.status === "connected") {
                    receipt(server.capabilityId, "applied", "Claude reports the MCP server connected", {
                        stage: "connected", source: "mcpServerStatus connected",
                    });
                } else {
                    receipt(
                        server.capabilityId,
                        mcpResult.ok && status?.status !== "pending" ? "failed" : "unverifiable",
                        status ? `Claude reports MCP server status ${status.status}` : "Claude did not report the configured MCP server",
                        { stage: mcpResult.ok ? "discovered" : "staged", source: "mcpServerStatus" },
                    );
                }
            }
            for (const tool of verification?.tools ?? []) {
                const discovered = mcpResult.value.some((server) =>
                    server.name === "polyth-agent-tools"
                    && server.status === "connected"
                    && server.tools?.some((candidate) => candidate.name === tool.name));
                receipt(
                    tool.capabilityId,
                    discovered ? "unverifiable" : mcpResult.ok ? "failed" : "unverifiable",
                    discovered
                        ? "Claude discovered the MCP tool; invocation was not observed"
                        : "Claude did not discover the MCP tool on the Polyth agent-tools server",
                    { stage: discovered ? "discovered" : mcpResult.ok ? "discovered" : "staged", source: "mcpServerStatus tools" },
                );
            }
            claudeOverlays.consumeIfRevision(context, "claude", staged.desiredRevision);
        }
        void (async () => {
            try {
                for await (const message of query!) {
                    if ("parent_tool_use_id" in message && message.parent_tool_use_id)
                        continue;
                    if (message.type === "system" && message.subtype === "commands_changed") {
                        nativeCommands.splice(0, nativeCommands.length, ...toNativeCommands(message.commands));
                        emit({ type: "runtime/commands-changed", commands: [...nativeCommands] }, message.uuid + ":commands");
                    }
                    if (message.type === "system" && message.subtype === "status"
                        && (message as { status?: string }).status === "requesting") {
                        // The SDK emits this immediately before the native API
                        // request. That is prompt-admission evidence: do not wait
                        // for the first completed assistant message before the UI
                        // can clear the composer and enter the working state.
                        markAccepted();
                    }
                    if (message.type === "rate_limit_event") {
                        const info = message.rate_limit_info;
                        if (info.status === "rejected" && info.resetsAt) {
                            pendingRetry = {
                                scope: "rate",
                                resetAt: info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000,
                                retryable: true,
                            };
                        }
                    }
                    if (message.type === "system" && message.subtype === "init") {
                        nativeModel = { providerID: "anthropic", modelID: message.model };
                        void query?.supportedCommands?.().then((cmds) => {
                            nativeCommands.splice(0, nativeCommands.length, ...toNativeCommands(cmds));
                            if (nativeCommands.length) emit({ type: "runtime/commands-changed", commands: [...nativeCommands] }, "init:commands");
                        }).catch(() => {});
                    }
                    if (message.type === "stream_event") {
                        const event = message.event as {
                            type?: string;
                            index?: number;
                            message?: { model?: string };
                            content_block?: { type?: string; id?: string; name?: string; input?: unknown };
                            delta?: { type?: string; text?: string };
                        };
                        if (event.type === "message_start") {
                            streamMessageOrdinal += 1;
                            streamPartIds.clear();
                            if (typeof event.message?.model === "string" && event.message.model) {
                                nativeModel = { providerID: "anthropic", modelID: event.message.model };
                            }
                            markAccepted();
                        }
                        if (event.type === "content_block_start" && typeof event.index === "number") {
                            const block = event.content_block;
                            if (block?.type === "text") streamPartId(event.index);
                            if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                                markAccepted();
                                const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
                                    ? block.input as JsonObject
                                    : {};
                                emit({ type: "tool/call", callId: block.id, tool: block.name, input, status: "pending" }, `${block.id}:pending`);
                            }
                        }
                        if (event.type === "content_block_delta" && typeof event.index === "number"
                            && event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
                            markAccepted();
                            const partId = streamPartId(event.index);
                            emit({ type: "assistant/chunk", partId, text: event.delta.text }, `${active}:stream:${streamEventOrdinal++}`);
                        }
                        // Thinking/signature deltas are intentionally ignored:
                        // Claude's private reasoning never enters continuity.
                    }
                    if (message.type === "assistant") {
                        if (message.message.model) nativeModel = { providerID: "anthropic", modelID: message.message.model };
                        markAccepted();
                        const body = message.message.content;
                        for (let i = 0; i < body.length; i++) {
                            const block = body[i]!;
                            const key = block.type === "text" ? (streamPartIds.get(i) ?? `${message.uuid}:${i}`) : `${message.uuid}:${i}`;
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
                        const resultId = message.uuid;
                        if (message.modelUsage && resultId !== lastResultId) {
                            const cumulative = usageFromModelUsage(message.modelUsage);
                            const rebased = lastUsage !== undefined && cumulative.input < lastUsage.input;
                            const tokens = rebased ? cumulative : deltaTokenUsage(lastUsage, cumulative);
                            const cost = rebased ? message.total_cost_usd : deltaCost(lastCost, message.total_cost_usd);
                            // modelUsage is an authoritative sample even when
                            // every counter is zero. Persisting that sample is
                            // what distinguishes zero usage from no telemetry.
                            lastUsage = cumulative;
                            lastCost = message.total_cost_usd;
                            lastResultId = resultId;
                            emit({
                                type: "usage/recorded",
                                model: nativeModel ?? { providerID: "anthropic", modelID: "unknown" },
                                tokens,
                                ...(cost !== undefined ? { cost, costSource: "derived" } : {}),
                            }, resultId + ":usage");
                        }
                        lastContextResultId = resultId;
                        const contextResultId = resultId;
                        void query?.getContextUsage?.({ detail: "summary" }).then((usage) => {
                            if (contextResultId !== lastContextResultId) return;
                            emit({ type: "context/updated", ...contextWindowTelemetry({
                                source: "native",
                                usedTokens: usage.totalTokens,
                                limitTokens: usage.maxTokens,
                            }) }, resultId + ":context");
                        }).catch(() => {});
                        void sdk.getSessionInfo(nativeId, { dir: context.cwd }).then((info) => {
                            if (!info) return;
                            const title = info.customTitle || info.summary;
                            if (title && !isPlaceholderTitle(title)) {
                                lastTitle = title;
                                emit({ type: "session/title-generated", title }, resultId + ":title");
                            }
                        }).catch(() => {});
                        const errorText = message.is_error && message.subtype !== "success"
                            ? ((message as { errors?: string[] }).errors?.[0] ?? "Claude Code turn failed")
                            : undefined;
                        const authFailed = Boolean(errorText && /authentication_failed/i.test(errorText));
                        const retry = message.is_error ? pendingRetry : undefined;
                        pendingRetry = undefined;
                        emit({
                            type: "turn/stopped",
                            turnId,
                            reason: message.is_error ? "error" : "completed",
                            ...(retry ? { retry } : {}),
                            ...(message.is_error ? {
                                error: errorText,
                                code: authFailed ? "auth-expired" : retry ? "rate-limited" : /rate.?limit|overloaded/i.test(errorText ?? "") ? "rate-limited" : "unknown",
                            } : {}),
                        }, turnId + ":stop");
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
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (request, operationId) => {
        let effort: string | undefined;
        if (request.model) {
            const known = peekClaudeModels({
                executable: claudeExecutable(),
                authFingerprint: claudeAuthFingerprint(),
            }) ?? [];
            const selection = resolveModelSelection(known, request.model, "claude");
            if (!selection.ok) return { kind: "rejected", code: selection.code, message: selection.message };
            effort = selection.variant;
        }
        const outcome = await mutate(operationId, async () => { const id = authority.receipts[operationId] ?? randomUUID(); await initialize(id, false, request.model?.modelID, effort); createId = operationId; await authority.receipt(operationId, id); return { backendSessionId: id }; });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: outcome.value.backendSessionId } : outcome;
    };
    /** Live session first (no spawn); otherwise a cached cold probe. */
    const catalog = async (): Promise<ModelDescriptor[]> => {
        if (query) return claudeModelDescriptors(await query.supportedModels());
        return discoverClaudeModels({
            query: sdk.query as Parameters<typeof discoverClaudeModels>[0]["query"],
            cwd: context.cwd,
            executable: claudeExecutable(),
            authFingerprint: claudeAuthFingerprint(),
        });
    };
    /** Bring the session's effort in line with the turn's selection. */
    const applyEffort = async (variant: string | undefined): Promise<void> => {
        const desired = variant ?? null;
        if (appliedEffort === desired) return;
        if (appliedEffort === undefined && desired === null) return;
        await query!.applyFlagSettings({ effortLevel: desired as EffortLevel | null });
        appliedEffort = desired;
    };
    const runtime: AgentRuntime = {
        capabilities: async () => CLAUDE_CAPABILITIES,
        commands: async () => [...nativeCommands],
        models: () => catalog(), agents: async () => [],
        createSessionOperation: create, resetSessionOperation: create,
        async ensureSession(input) { if (!input.backendSessionId)
            throw Object.assign(new Error("Operation-aware creation required"), { code: "unsupported" }); const info = await sdk.getSessionInfo(input.backendSessionId, { dir: context.cwd }); await initialize(input.backendSessionId, Boolean(info)); return nativeId; },
        sessions: async () => Object.entries(authority.receipts).map(([operationId, id]) => ({
            id,
            operationId,
            title: lastTitle || "Claude Code session",
            createdAt: 0,
            updatedAt: 0,
        })), history: async () => [],
        async startTurnOperation(request, operationId) {
            if (!query || active)
                return { kind: "rejected", code: "unsupported", message: "Claude Code supports idle turns on its native account" };
            // The live query already holds the catalog from `initialize`, so
            // validating a selection costs no process and no network call.
            let selectedVariant: string | undefined;
            if (request.model) {
                let available: ModelDescriptor[];
                try {
                    available = await catalog();
                } catch {
                    return {
                        kind: "rejected",
                        code: "discovery-unavailable",
                        message: "Claude Code could not verify the available models for this session.",
                    };
                }
                const selection = resolveModelSelection(available, request.model, "claude");
                if (!selection.ok) return { kind: "rejected", code: selection.code, message: selection.message };
                selectedVariant = selection.variant;
            }
            const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];
            const delivered = composeTurnPrompt(request.text, request.attachments);
            const readBytes = (path: string) => readFile(isAbsolute(path) ? path : join(context.cwd, path));
            for (const image of delivered.images) {
                const data = await readBytes(image.localPath);
                content.push({ type: "image", source: { type: "base64", media_type: image.mime, data: data.toString("base64") } });
            }
            if (request.attachments?.length) {
                for (const ref of request.attachments) {
                    if (ref.kind === "browser-context") continue;
                    if (ref.mime?.startsWith("image/")) {
                        const path = ref.path;
                        if (!path) return { kind: "rejected", code: "invalid-attachment", message: "Image attachment requires a materialized path" };
                        const data = await readBytes(path);
                        content.push({ type: "image", source: { type: "base64", media_type: ref.mime ?? "image/png", data: data.toString("base64") } });
                    } else if (ref.mime === "application/pdf") {
                        const path = ref.path;
                        if (!path) return { kind: "rejected", code: "invalid-attachment", message: "PDF attachment requires a materialized path" };
                        const data = await readBytes(path);
                        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } });
                    } else {
                        // Text files arrive as a projected prompt section, so
                        // anything left here has no Claude content block.
                        return {
                            kind: "rejected",
                            code: "unsupported",
                            message: unsupportedAttachmentMessage(attachmentModality(ref), "Claude Code"),
                        };
                    }
                }
            }
            content.push({ type: "text", text: delivered.text });
            try {
                if (request.model)
                    await query.setModel(request.model.modelID);
                await applyEffort(selectedVariant);
            } catch {
                return {
                    kind: "rejected",
                    code: "native-failure",
                    message: "Claude Code did not accept the model or thinking level for this session.",
                };
            }
            active = operationId;
            streamMessageOrdinal = -1;
            streamEventOrdinal = 0;
            streamPartIds.clear();
            order++;
            return new Promise(resolve => { admission = () => resolve({ kind: "confirmed", value: { admissionId: operationId }, receipt: operationId }); inputs.push({ type: "user", uuid: operationId as SDKUserMessage["uuid"], session_id: nativeId, parent_tool_use_id: null, message: { role: "user", content: content as SDKUserMessage["message"]["content"] } }); wake?.(); });
        },
        startTurn: async () => { throw new Error("Operation-aware admission required"); },
        abort: async () => { await query?.interrupt(); },
        abortOperation: (_id, operationId) => mutate(operationId, async () => { await query?.interrupt(); return {}; }),
        async replyPermission(_id, requestId, reply) { const request = permissions.get(requestId); if (!request)
            throw Object.assign(new Error("Permission no longer pending"), { code: "not-found" }); permissions.delete(requestId); request.resolve(reply === "reject" ? { behavior: "deny", message: "User declined" } : { behavior: "allow", updatedInput: request.input }); },
        replyPermissionOperation: async (_id, requestId, reply, operationId) => {
            try {
                await runtime.replyPermission(context.sessionId!, requestId, reply);
                return { kind: "confirmed", value: {} };
            }
            catch (error) {
                // A reply for a request the SDK no longer holds is a definitive
                // no-op, not an uncertain outcome. Reporting `unknown` here leaves a
                // durable blocking operation that reconciliation can never settle
                // (absence from a snapshot is deliberately not proof), wedging send
                // admission forever. Mirror the question path's not-found handling.
                if ((error as { code?: unknown }).code === "not-found")
                    return { kind: "rejected", code: "not-found", message: "Permission is no longer pending" };
                return { kind: "unknown", operationId, message: "Claude Code did not confirm the operation" };
            }
        },
        replyQuestion: async () => { throw Object.assign(new Error("Questions unsupported"), { code: "unsupported" }); },
        endpoint: async () => endpoint, protocol: async () => "legacy",
        reconcile: async (binding) => { reconciliationOrdinal = binding.reconciliationOrdinal ?? 0; return ({ ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0, state: { value: !connected || nativeId !== binding.backendSessionId ? "unknown" : active ? "running" : "idle", comparison: { domain: authority.authorityId, order: ++order }, ...(createId && !accepted.length ? { causalOperationId: createId } : {}) }, completeness: { events: "partial", permissions: connected ? "complete" : "unverifiable", questions: "complete" }, events, permissions: [...permissions].map(([requestId, p]) => ({ requestId, permission: p.tool, patterns: [p.tool] })), questions: [], acceptedOperations: accepted }); },
        releaseExecution: (binding, operationId) => mutate(operationId, async () => { if ((binding.authorityId !== authority.authorityId || binding.generation !== authority.generation) && !authority.releasedAuthorities.some(p => p.authorityId === binding.authorityId && p.generation === binding.generation))
            throw new Error("Authority mismatch"); if (!binding.backendSessionId || binding.backendSessionId !== nativeId)
            throw Object.assign(new Error("release requires the native backend session"), { code: "unknown-session" }); await runtime.dispose(); return { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId }; }),
        onEvent: cb => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; }, onObservation: cb => { observations.add(cb); return { dispose: () => { observations.delete(cb); } }; }, onLifecycle: cb => { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
        async dispose() { connected = false; wake?.(); await authority.close(); query?.close(); },
    };
    return runtime;
}
