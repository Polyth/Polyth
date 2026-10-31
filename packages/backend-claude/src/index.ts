import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentRuntime, HarnessContext, JsonObject, ModelDescriptor, ModelRef, MutationOutcome, RateLimitRetryHint, RuntimeCommandDescriptor, RuntimeEvent, RuntimeObservation, RuntimeSnapshot, TokenUsage, WorkspaceContext } from "@polyth/contracts";
import { runtimeEventHasTurnContent } from "@polyth/contracts";
import { createTodoToolTracker } from "@polyth/todos";
import { agentBetaEnabled, attachmentModality, composeTurnPrompt, contextWindowTelemetry, createProcessAuthority, deltaCost, deltaTokenUsage, isPlaceholderTitle, normalizeTokenUsage, resolveModelSelection, unsupportedAttachmentMessage } from "@polyth/harness-runtime";
import type { EffortLevel, SDKUserMessage, Query, PermissionResult, Settings, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
    acknowledgeCapabilityApplication,
    captureCapabilityLaunch,
    provisioningTarget,
    releaseCapabilityLaunch,
} from "@polyth/harness-runtime";
import {claudeAuthFingerprint, claudeModelDescriptors, discoverClaudeModels, invalidateClaudeModelCache, peekClaudeModels, CLAUDE_ULTRACODE_VARIANT} from "./discovery.ts";
import { claudeOverlays, removeClaudeMcpConfigFiles, writeClaudeMcpConfigFile } from "./provisioner.ts";
import { CLAUDE_QUESTION_DISMISSED, CLAUDE_QUESTION_TOOL, CLAUDE_QUESTION_UNREADABLE, claudeQuestionAnswers, claudeQuestionItems, parseClaudeQuestions, type ClaudeQuestion } from "./questions.ts";

/** How many unadmitted model events may pass before the native loop is
 *  interrupted. Bounded so a stray loop cannot spend a provider turn budget
 *  while Polyth refuses to own it. */
const UNADMITTED_INTERRUPT_AFTER = 25;
/** How long a turn waits for an interrupted unadmitted loop to finish. */
const UNADMITTED_SETTLE_MS = 10_000;
/** A `/compact` reports its outcome in a status message; the CLI's closing
 *  `result` normally follows at once. Stop waiting for it after this long. */
const COMPACTION_RESULT_GRACE_MS = 5_000;
/** Claude Code's fixed opening of the user message that carries its summary. */
const COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";
const MAX_COMPACT_SUMMARY_CHARS = 8_000;

/** The summary part of Claude Code's post-compaction user message. */
export function claudeCompactSummary(content: unknown): string | undefined {
    const text = typeof content === "string"
        ? content
        : Array.isArray(content)
            ? content.map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
                ? String((block as { text?: unknown }).text ?? "")
                : "").join("\n")
            : "";
    if (!text.trimStart().startsWith(COMPACT_SUMMARY_PREFIX)) return undefined;
    const marker = text.indexOf("Summary:");
    const summary = (marker >= 0 ? text.slice(marker + "Summary:".length) : text).trim();
    if (!summary) return undefined;
    return summary.length > MAX_COMPACT_SUMMARY_CHARS
        ? `${summary.slice(0, MAX_COMPACT_SUMMARY_CHARS - 1).trimEnd()}…`
        : summary;
}
type TaskNotification = {
    uuid: string;
    task_id: string;
    status: string;
    summary?: string;
    output_file?: string;
    skip_transcript?: boolean;
    ambient?: boolean;
};
/** The prompt Polyth sends for background work that settled while idle. */
const backgroundTaskWakeText = (note: TaskNotification): string => [
    "A background task you started has finished while no turn was running.",
    `Task: ${note.task_id}`,
    `Status: ${note.status}`,
    ...(note.summary ? [`Summary: ${note.summary}`] : []),
    ...(note.output_file ? [`Output file: ${note.output_file}`] : []),
    "",
    "Read its result and continue your task.",
].join("\n");
export { claudeOverlays, createClaudeProvisioner } from "./provisioner.ts";
export { claudeAuthFingerprint, claudeModelDescriptors, discoverClaudeModels, invalidateClaudeModelCache } from "./discovery.ts";
type Sdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query" | "getSessionInfo">;
const claudeExecutable = (): string => process.env.POLYTH_CLAUDE_BIN ?? "claude";
const protectClaudeMcpConfigArgs = (
    context: HarnessContext,
    args: readonly string[],
    protectedFiles: Set<string>,
): string[] => {
    const protectedArgs = [...args];
    const protect = (value: string): string => {
        const trimmed = value.trim();
        if (!trimmed.startsWith("{")) return value;
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        } catch {
            throw new Error("Claude SDK produced an invalid MCP configuration");
        }
        const path = writeClaudeMcpConfigFile(context, trimmed);
        protectedFiles.add(path);
        return path;
    };
    for (let index = 0; index < protectedArgs.length; index++) {
        const arg = protectedArgs[index]!;
        if (arg === "--mcp-config" && index + 1 < protectedArgs.length) {
            protectedArgs[index + 1] = protect(protectedArgs[index + 1]!);
            index++;
        } else if (arg.startsWith("--mcp-config=")) {
            protectedArgs[index] = `--mcp-config=${protect(arg.slice("--mcp-config=".length))}`;
        }
    }
    return protectedArgs;
};
export const CLAUDE_CAPABILITIES = {
    streaming: true, permissions: true, questions: true, compaction: true, subagents: false,
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
    promptSuggestions: true,
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
/** Anthropic `input_tokens` excludes cache reads and writes, so the four
 * counters are independent and a running query total only ever grows. */
const usageRegressed = (current: TokenUsage, previous: TokenUsage): boolean =>
    current.input < previous.input
    || current.output < previous.output
    || (current.cacheRead ?? 0) < (previous.cacheRead ?? 0)
    || (current.cacheWrite ?? 0) < (previous.cacheWrite ?? 0);
const usageIsEmpty = (usage: TokenUsage): boolean =>
    !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite;
const addUsage = (a: TokenUsage | undefined, b: TokenUsage): TokenUsage => normalizeTokenUsage({
    input: (a?.input ?? 0) + b.input,
    output: (a?.output ?? 0) + b.output,
    cacheRead: (a?.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
});
/** Anthropic stream usage: `message_start` carries the request's input side,
 *  `message_delta` the final (cumulative) counters, and may repeat input ones. */
type StreamUsage = {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
};
const requestUsage = (start: StreamUsage | undefined, end: StreamUsage | undefined): TokenUsage => normalizeTokenUsage({
    input: end?.input_tokens ?? start?.input_tokens,
    output: end?.output_tokens ?? start?.output_tokens,
    cacheRead: end?.cache_read_input_tokens ?? start?.cache_read_input_tokens,
    cacheWrite: end?.cache_creation_input_tokens ?? start?.cache_creation_input_tokens,
});
/** The CLI labels its own locally generated messages (API errors, rate-limit
 *  notices) with this model id. It names no model the session runs on. */
const SYNTHETIC_MODEL_ID = "<synthetic>";
const anthropicModel = (modelID: unknown): ModelRef | undefined =>
    typeof modelID === "string" && modelID && modelID !== SYNTHETIC_MODEL_ID
        ? { providerID: "anthropic", modelID }
        : undefined;
/** Mid-turn context probes are answered locally by the CLI (`summary` detail
 *  makes no token-count calls), but one per request is still more than the
 *  gauge needs during a long tool loop. */
const CONTEXT_PROBE_INTERVAL_MS = 10_000;
const toNativeCommands = (
    harnessId: string,
    commands: Array<{ name: string; description?: string; argumentHint?: string }>,
    skillAliases?: ReadonlyMap<string, string>,
): RuntimeCommandDescriptor[] =>
    commands.map((cmd) => {
        const alias = skillAliases?.get(cmd.name);
        return {
            id: `native:${harnessId}:${cmd.name}`,
            name: cmd.name,
            ...(alias && alias !== cmd.name ? { aliases: [alias] } : {}),
            ...(cmd.description ? { description: cmd.description } : {}),
            ...(cmd.argumentHint ? { argumentHint: cmd.argumentHint, acceptsArguments: true } : {}),
            owner: "native",
            harnessId,
            invocation: "raw-native-input",
            availability: "session",
        };
    });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Resolve the canonical workspace membership into Claude's native directory
 * allowlist. Public turn input never supplies paths: these rows are already
 * server-resolved and must belong to this exact project/session. */
export function claudeWorkspaceDirectories(context: HarnessContext, workspace: WorkspaceContext | undefined, canonicalSessionId: string = context.sessionId ?? ""):
    { ok: true; additionalDirectories: string[] } | { ok: false; message: string } {
    if (!workspace) return { ok: true, additionalDirectories: [] };
    if (workspace.projectId !== context.projectId || workspace.sessionId !== canonicalSessionId || (context.sessionId !== undefined && context.sessionId !== canonicalSessionId)) {
        return { ok: false, message: "Claude workspace does not belong to this project or session" };
    }
    if (workspace.repositories.length > 128) return { ok: false, message: "Claude workspace contains too many repository roots" };
    if (!isAbsolute(context.cwd) || context.cwd.includes("\0")) return { ok: false, message: "Claude execution root must be absolute and NUL-free" };
    const cwd = resolve(context.cwd);
    const roots = new Set<string>();
    let hasExecutionRoot = false;
    for (const repository of workspace.repositories) {
        if (repository.path.includes("\0")) return { ok: false, message: "Claude workspace contains a NUL path" };
        if (repository.state !== "ready") continue;
        if (!isAbsolute(repository.path)) return { ok: false, message: "Claude workspace contains a non-absolute repository root" };
        const root = resolve(repository.path);
        roots.add(root);
        if (root === cwd) hasExecutionRoot = true;
        if (roots.size > 128) return { ok: false, message: "Claude workspace contains too many repository roots" };
    }
    if (!hasExecutionRoot) return { ok: false, message: "Claude workspace does not authorize its execution root" };
    roots.delete(cwd);
    return { ok: true, additionalDirectories: [...roots] };
}
/** Claude Code waits up to ~2s for an in-flight OAuth refresh on shutdown; the
 * SDK keeps a matching 2s grace before it signals the transport. Wait a little
 * longer than that before the process authority's containment release. */
const CLAUDE_SHUTDOWN_GRACE_MS = 4_000;
/** The shared ~/.claude refresh lock stays contended for its 60s staleness
 * window after the holder dies. The CLI's own guidance is to retry in a minute. */
const CLAUDE_OAUTH_REFRESH_LOCK_RE = /Failed to refresh OAuth token: another Claude Code process/i;
/** A model request that died on the wire (the CLI's Bun fetch reports e.g.
 * "ECONNRESET: The socket connection was closed unexpectedly") once Claude
 * Code's own retries gave up. Tools run locally and finish before the next
 * request, so only a model call was lost: a bounded resend is safe. */
const CLAUDE_TRANSPORT_FAILURE_RE = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET)\b|socket connection was closed unexpectedly|socket hang up|\bfetch failed\b|\bConnection error\b|\bRequest timed out\b/i;
/** The SDK owns its protocol; Polyth owns the SDK's native child process and
 * records only public dialogue/tool outcomes. It never consumes thinking. */
export interface ClaudeRuntimeOptions {
    /** Harness id this runtime serves; each Claude account is its own harness. */
    harnessId?: string;
    /** Model-cache identity of the account's credential source. */
    authFingerprint?: string;
    /** Space preferences read when a native query starts. Absent means
     * Polyth's defaults: suggestions on, no inherited native skills. */
    launchPreferences?: () => Promise<ClaudeLaunchPreferences>;
}
export interface ClaudeLaunchPreferences {
    /** Ask Claude Code for a predicted next prompt after each turn. */
    promptSuggestions: boolean;
    /** Offer Claude Code's own (user, project and plugin) skills. */
    inheritSkills: boolean;
    /** Inherited skills that stay hidden from the model and the slash menu. */
    mutedSkills: readonly string[];
}
export const DEFAULT_CLAUDE_LAUNCH_PREFERENCES: ClaudeLaunchPreferences = { promptSuggestions: true, inheritSkills: false, mutedSkills: [] };

/** The pinned Agent SDK's Settings type predates Claude Code's session-scoped
 * `ultracode` flag. The CLI accepts it through the same settings layer, so the
 * augmentation stays local rather than widening every SDK settings object. */
type ClaudeLaunchSettings = Settings & { ultracode?: boolean };
type ClaudeFlagSettings = Parameters<Query["applyFlagSettings"]>[0] & { ultracode?: boolean | null };

/** Map a picker variant to the SDK's effort and ultracode flags. Ultracode is
 * a separate session setting, not an effort level; selecting it runs at xhigh. */
const claudeVariantFlags = (variant: string | undefined): { effort?: EffortLevel; ultracode: boolean } =>
    variant === CLAUDE_ULTRACODE_VARIANT
        ? { effort: "xhigh", ultracode: true }
        : { effort: variant as EffortLevel | undefined, ultracode: false };
/** Native skill options for one launch. Without inheritance an explicit
 * allowlist keeps unrelated user/global skills out of this Space-private
 * session; with it every discovered skill loads except the muted ones. */
export function claudeSkillLaunchOptions(
    preferences: Pick<ClaudeLaunchPreferences, "inheritSkills" | "mutedSkills">,
    polythSkills: readonly string[],
): { skills: string[] | "all"; settings?: { skillOverrides: Record<string, "off"> } } {
    if (!preferences.inheritSkills) return { skills: [...polythSkills] };
    const muted = preferences.mutedSkills.filter((name) => !polythSkills.includes(name));
    return {
        skills: "all",
        ...(muted.length ? { settings: { skillOverrides: Object.fromEntries(muted.map((name) => [name, "off" as const])) } } : {}),
    };
}
export async function createClaudeRuntime(context: HarnessContext, sdk: Sdk, authority: Awaited<ReturnType<typeof createProcessAuthority>>, options: ClaudeRuntimeOptions = {}): Promise<AgentRuntime> {
    const harnessId = options.harnessId ?? "claude";
    const authFingerprint = options.authFingerprint ?? claudeAuthFingerprint();
    let query: Query | undefined;
    const protectedMcpConfigFiles = new Set<string>();
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
    /** Model output the SDK produced with no Polyth turn behind it: a leg that
     *  is still looping after its turn closed, a resumed native thread Polyth
     *  never re-admitted, or a loop the SDK started on its own. It is never
     *  reported as session content. */
    let unadmittedEvents = 0;
    /** A native loop with no Polyth turn behind it is running right now. A turn
     *  submitted meanwhile waits for it to settle, or the loop's events and its
     *  result would be attributed to (and close) the newly admitted turn. */
    let unadmittedLoop: { settled: Promise<void>; settle(): void } | undefined;
    /** Background work settled while idle and was handed to Polyth as a wake
     *  request; the CLI's own loop for it is redundant and is stopped at once. */
    let wakeHandedOff = false;
    /** A `/compact` Polyth asked for. It is not a turn: what the CLI streams
     *  while it summarizes is never session content. `confirm` answers the
     *  operation until Claude reports that it started compacting. */
    let compaction: {
        operationId: string;
        confirm?: (outcome: MutationOutcome<{ completion?: "pending" }>) => void;
        outcome?: "success" | "failed";
        boundary?: boolean;
    } | undefined;
    /** A native compaction boundary waiting for its summary message. */
    let pendingBoundary: string | undefined;
    const noteUnadmittedLoop = () => {
        if (!unadmittedLoop) {
            let settle!: () => void;
            const settled = new Promise<void>((resolve) => { settle = resolve; });
            unadmittedLoop = { settled, settle };
        }
        if (wakeHandedOff) {
            wakeHandedOff = false;
            void query?.interrupt().catch(() => {});
        }
    };
    const settleUnadmittedLoop = () => {
        const loop = unadmittedLoop;
        unadmittedLoop = undefined;
        loop?.settle();
    };
    const accepted: NonNullable<RuntimeSnapshot["acceptedOperations"]> = [];
    const events: RuntimeSnapshot["events"] = [];
    const listeners = new Set<(sid: string, event: RuntimeEvent) => void>();
    // Route events to the canonical session named by the operation. A runtime
    // created for a workspace (no session at creation, e.g. utility work) would
    // otherwise emit to `undefined` and every listener would drop the event.
    let sid = context.sessionId ?? "";
    const observations = new Set<(sid: string, event: RuntimeObservation) => void>();
    const lifecycle = new Set<Parameters<NonNullable<AgentRuntime["onLifecycle"]>>[0]>();
    let lastUsage: TokenUsage | undefined;
    let lastCost: number | undefined;
    let lastResultId = "";
    /** One usage sample per completed main-thread API request, reported while
     *  the turn runs. The result's cumulative `modelUsage` then contributes only
     *  what these samples did not cover (side models, unstreamed requests). */
    let requestStartUsage: StreamUsage | undefined;
    let requestEndUsage: StreamUsage | undefined;
    let requestModel: ModelRef | undefined;
    let requestOrdinal = -1;
    let streamedUsage: TokenUsage | undefined;
    let contextProbeSeq = 0;
    let contextProbeInFlight = false;
    let lastContextProbeAt = 0;
    let lastTitle = "";
    let titleProbeInFlight = false;
    let titleProbeAgain = false;
    let pendingRetry: RateLimitRetryHint | undefined;
    /** The last rejection the CLI reported. It sends `rate_limit_event` only
     *  when the limit state changes, so a later turn that runs into the same
     *  limit gets just the `rate_limit` synthetic message; this supplies its
     *  reset time. */
    let rejectedLimit: RateLimitRetryHint | undefined;
    /** Text the CLI wrote itself (`<synthetic>` model), held until the turn's
     *  result: a provider-limit stop shows the resume notice instead of this
     *  "You've hit your limit" line; any other outcome publishes it as before. */
    let syntheticNotices: Array<{ key: string; text: string }> = [];
    let resolveStreamFinished!: () => void;
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve; });
    let streamLoopActive = false;
    let streamMessageOrdinal = -1;
    let streamEventOrdinal = 0;
    const streamPartIds = new Map<number, string>();
    const streamThinkingIndexes = new Set<number>();
    const finalizedStreamPartIds = new Set<string>();
    const nativeCommands: RuntimeCommandDescriptor[] = [];
    // TodoWrite (full list) and TaskCreate/TaskUpdate/TaskList (incremental)
    // become the canonical task snapshot the timeline, status and island render.
    const todos = createTodoToolTracker({ revisionClock: Date.now });
    let nativeSkillAliases = new Map<string, string>();
    const permissions = new Map<string, {
        resolve(result: PermissionResult): void;
        input: Record<string, unknown>;
        tool: string;
    }>();
    /** Pending `AskUserQuestion` calls, keyed by tool-use id. */
    const questions = new Map<string, {
        resolve(result: PermissionResult): void;
        input: Record<string, unknown>;
        questions: ClaudeQuestion[];
        items: JsonObject[];
    }>();
    const endpoint = { authorityId: authority.authorityId, generation: authority.generation, continuity: "generation-only" as const, url: "sdk:", location: { directory: context.cwd }, control: { kind: "owned" as const, instanceToken: authority.authorityId }, config: { kind: "read-only" as const }, authentication: { kind: "none" as const } };
    const emit = (event: RuntimeEvent, key: string) => {
        const revision = digest(event);
        const artifactKind = event.type.startsWith("tool/") ? "tool" : event.type.startsWith("turn/") ? "turn" : event.type === "permission/requested" ? "permission" : event.type === "question/asked" ? "question" : "message";
        // Live and pull must claim one durable entity: the snapshot carries the
        // same artifact kind the observation below publishes.
        events.push({ entityKey: key, revision, artifactKind, events: [event] });
        if (observations.size && reconciliationOrdinal > 0)
            for (const cb of observations)
                cb(sid, { channel: "sse", entityKey: key, identity: { ...endpoint, backendSessionId: nativeId, artifactKind, entityId: key, revision }, reconciliationOrdinal, events: [event] });
        else
            for (const cb of listeners)
                cb(sid, event);
    };
    const markAccepted = () => { if (admission) {
        const done = admission;
        admission = undefined;
        accepted.push({ operationId: active, mutationKind: "turn-submit", receipt: active });
        emit({ type: "turn/started", turnId: active, ...(nativeModel ? { model: nativeModel } : {}) }, active + ":start");
        done();
    } };
    /** Polyth owns turn admission. Turn content is only session content while a
     *  Polyth turn is live: `active` names the admitted operation, `admission`
     *  is the turn being admitted right now. Anything the SDK produces outside
     *  both is refused here instead of being emitted with an empty turn prefix,
     *  which used to land in the canonical log as a turn that never existed. */
    const emitAdmitted = (event: RuntimeEvent, key: string): boolean => {
        if (!runtimeEventHasTurnContent(event.type)) {
            emit(event, key);
            return true;
        }
        // The CLI's own summarizing work for a `/compact`: expected, not a loop.
        if (compaction && !active && !admission) return false;
        if (!active && !admission) {
            noteUnadmittedLoop();
            unadmittedEvents += 1;
            if (unadmittedEvents === 1 || unadmittedEvents % 50 === 0) {
                console.warn(`[polyth] refused ${unadmittedEvents} unadmitted Claude ${event.type} event(s) for ${context.sessionId ?? "workspace"}: the native thread is producing work with no Polyth turn`);
            }
            // A loop nobody asked for must not run forever: stop it with the same
            // proven interrupt an abort uses, and let Polyth re-admit a turn.
            if (unadmittedEvents === UNADMITTED_INTERRUPT_AFTER) {
                void query?.interrupt().catch(() => {});
            }
            return false;
        }
        emit(event, key);
        return true;
    };
    const flushSyntheticNotices = () => {
        const notices = syntheticNotices;
        syntheticNotices = [];
        for (const notice of notices) emitAdmitted({ type: "assistant/message", partId: notice.key, text: notice.text }, notice.key);
    };
    const streamPartId = (index: number): string => {
        const existing = streamPartIds.get(index);
        if (existing) return existing;
        const ordinal = Math.max(0, streamMessageOrdinal);
        const partId = `${active}:stream:${ordinal}:${index}`;
        streamPartIds.set(index, partId);
        return partId;
    };
    const streamTextPartIds = (): string[] => [...streamPartIds.entries()]
        .filter(([index]) => !streamThinkingIndexes.has(index))
        .sort((a, b) => a[0] - b[0])
        .map(([, partId]) => partId);
    const streamThinkingPartIds = (): string[] => [...streamPartIds.entries()]
        .filter(([index]) => streamThinkingIndexes.has(index))
        .sort((a, b) => a[0] - b[0])
        .map(([, partId]) => partId);
    const resetStreamParts = () => {
        streamPartIds.clear();
        streamThinkingIndexes.clear();
        finalizedStreamPartIds.clear();
    };
    /** Latest probe wins: an older answer that lands late must not overwrite a
     *  newer occupancy sample. */
    const probeContext = (force = false): void => {
        if (typeof query?.getContextUsage !== "function") return;
        const now = Date.now();
        if (!force && (contextProbeInFlight || now - lastContextProbeAt < CONTEXT_PROBE_INTERVAL_MS)) return;
        lastContextProbeAt = now;
        contextProbeInFlight = true;
        const seq = ++contextProbeSeq;
        void query.getContextUsage({ detail: "summary" }).then((usage) => {
            if (seq !== contextProbeSeq) return;
            emit({ type: "context/updated", ...contextWindowTelemetry({
                source: "native",
                usedTokens: usage.totalTokens,
                limitTokens: usage.maxTokens,
            }) }, `${nativeId}:context:${seq}`);
        }).catch(() => {}).finally(() => {
            if (seq === contextProbeSeq) contextProbeInFlight = false;
        });
    };
    /** Manual or automatic, the native context was summarized: the canonical
     *  marker lets the next turn restore what the summary may have dropped. */
    const publishCompacted = (summary?: string): void => {
        const id = pendingBoundary;
        if (!id) return;
        pendingBoundary = undefined;
        emit({ type: "session/compacted", backendEventId: id, ...(summary ? { summary } : {}) }, `${id}:compacted`);
        probeContext(true);
    };
    const finishCompaction = (outcome: "success" | "failed", error?: string): void => {
        const current = compaction;
        if (!current || current.outcome) return;
        current.outcome = outcome;
        if (outcome === "success") publishCompacted();
        const message = error?.trim() || "Claude Code could not compact the conversation";
        if (current.confirm) {
            const confirm = current.confirm;
            current.confirm = undefined;
            confirm(outcome === "success"
                ? { kind: "confirmed", value: {}, receipt: current.operationId }
                : { kind: "rejected", code: "native-failure", message });
        } else if (outcome === "failed") {
            emit({ type: "session/compaction-failed", error: message }, `${current.operationId}:compaction-failed`);
        }
        // The closing `result` is swallowed while this lasts; one that never
        // comes must not keep later turns out.
        setTimeout(() => { if (compaction === current) compaction = undefined; }, COMPACTION_RESULT_GRACE_MS).unref?.();
    };
    /** `summary` falls back to the last or first prompt. Only `customTitle` —
     *  a `/rename` title or Claude Code's own AI title — names the session. */
    const nativeTitle = async (id: string): Promise<string | undefined> => {
        // A private session has no transcript for Claude Code to title.
        if (context.privateSession) return undefined;
        const info = await sdk.getSessionInfo(id, { dir: context.cwd });
        const title = info?.customTitle?.trim();
        return title && !isPlaceholderTitle(title, id) ? title : undefined;
    };
    /** Claude Code writes its AI title a few seconds into the first turn, long
     *  before that turn's result. Report it as soon as it exists. */
    const probeTitle = (): void => {
        if (!nativeId) return;
        if (titleProbeInFlight) {
            titleProbeAgain = true;
            return;
        }
        titleProbeInFlight = true;
        const id = nativeId;
        void nativeTitle(id).then((title) => {
            if (!title || title === lastTitle) return;
            lastTitle = title;
            emit({ type: "session/title-generated", title }, `${id}:title:${digest(title).slice(0, 16)}`);
        }).catch(() => {}).finally(() => {
            titleProbeInFlight = false;
            if (titleProbeAgain) {
                titleProbeAgain = false;
                probeTitle();
            }
        });
    };
    const flushRequestUsage = (): void => {
        const start = requestStartUsage;
        if (!start) return;
        const tokens = requestUsage(start, requestEndUsage);
        const model = requestModel ?? nativeModel ?? { providerID: "anthropic", modelID: "unknown" };
        requestStartUsage = undefined;
        requestEndUsage = undefined;
        requestModel = undefined;
        if (!usageIsEmpty(tokens)
            && emitAdmitted({ type: "usage/recorded", model, tokens, quality: "exact" }, `${active}:usage:${requestOrdinal}`)) {
            streamedUsage = addUsage(streamedUsage, tokens);
        }
        probeContext();
        if (!lastTitle) probeTitle();
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
    /** Ultracode is a separate session flag, not an effort level. Track it so
     *  a variant change does not silently turn it off. */
    let appliedUltracode = false;
    let appliedWorkspaceDirectories: string[] | undefined = [];
    const initialize = async (id: string, resume = false, model?: string, variant?: string) => {
        if (query) {
            if (nativeId !== id)
                throw Object.assign(new Error("Fresh native session requires a released process"), { code: "unsupported" });
            return;
        }
        nativeId = id;
        const launch = claudeVariantFlags(variant);
        const staged = claudeOverlays.peek(context, harnessId);
        const overlay = staged?.value;
        const launchTarget = provisioningTarget(context, harnessId);
        if (staged) {
            captureCapabilityLaunch({
                target: launchTarget,
                desiredRevision: staged.desiredRevision,
            });
        }
        let initialization!: Awaited<ReturnType<Query["initializationResult"]>>;
        const preferences = await (options.launchPreferences?.().catch(() => DEFAULT_CLAUDE_LAUNCH_PREFERENCES) ?? DEFAULT_CLAUDE_LAUNCH_PREFERENCES);
        const skillOptions = claudeSkillLaunchOptions(preferences, overlay?.skills ?? []);
        const launchSettings: ClaudeLaunchSettings = {
            ...(skillOptions.settings ?? {}),
            ...(launch.ultracode ? { ultracode: true } : {}),
        };
        try {
            query = sdk.query({ prompt: prompts(), options: { cwd: context.cwd, ...(resume ? { resume: id } : { sessionId: id }), pathToClaudeCodeExecutable: claudeExecutable(), permissionMode: "default", includePartialMessages: true,
                    // A private session leaves no transcript in
                    // `<config>/projects`; Polyth's history is its only copy.
                    ...(context.privateSession ? { persistSession: false } : {}),
                    ...(launch.effort ? { effort: launch.effort } : {}),
                    ...(model ? { model } : {}),
                    // Delegation belongs to canonical Polyth child sessions.
                    // Agent beta keeps read/browser interaction available but
                    // removes every native workspace mutation escape hatch.
                    disallowedTools: agentBetaEnabled()
                        ? ["Agent", "Task", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]
                        : ["Agent", "Task"],
                    ...(overlay?.append ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: overlay.append } } : {}),
                    ...(overlay?.mcpServers ? { mcpServers: overlay.mcpServers } : {}),
                    ...(overlay?.plugins ? { plugins: overlay.plugins } : {}),
                    pluginDelivery: "initialize",
                    ...skillOptions,
                    ...(Object.keys(launchSettings).length ? { settings: launchSettings } : {}),
                    // The suggestion arrives after `result`; the stream loop
                    // keeps reading, so it reaches the idle composer.
                    promptSuggestions: preferences.promptSuggestions,
                    spawnClaudeCodeProcess(options) {
                        const args = protectClaudeMcpConfigArgs(context, options.args, protectedMcpConfigFiles);
                        const child = authority.spawn(options.command, args, { cwd: options.cwd, env: options.env, signal: options.signal });
                        child.stderr!.resume();
                        return child as SpawnedProcess;
                    },
                    canUseTool: async (tool, input, options) => {
                        markAccepted();
                        const requestId = (options as {
                            toolUseID?: string;
                        }).toolUseID ?? randomUUID();
                        if (tool === CLAUDE_QUESTION_TOOL) {
                            const parsed = parseClaudeQuestions(input);
                            if (!parsed) return { behavior: "deny", message: CLAUDE_QUESTION_UNREADABLE };
                            const items = claudeQuestionItems(parsed);
                            return new Promise<PermissionResult>(resolve => { questions.set(requestId, { resolve, input, questions: parsed, items }); emit({ type: "question/asked", requestId, questions: items }, requestId); options.signal.addEventListener("abort", () => { questions.delete(requestId); resolve({ behavior: "deny", message: "Cancelled" }); }, { once: true }); });
                        }
                        return new Promise<PermissionResult>(resolve => { permissions.set(requestId, { resolve, input, tool }); emit({ type: "permission/requested", requestId, permission: tool, patterns: [String(input.command ?? input.file_path ?? tool)] }, requestId); options.signal.addEventListener("abort", () => { permissions.delete(requestId); resolve({ behavior: "deny", message: "Cancelled" }); }, { once: true }); });
                    },
                } });
            initialization = await query.initializationResult();
            if (launch.effort) appliedEffort = launch.effort;
            appliedUltracode = launch.ultracode;
            // A fresh query starts with no extra roots. A resumed native
            // session may retain roots from before this runtime existed.
            appliedWorkspaceDirectories = resume ? undefined : [];
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
            nativeSkillAliases = new Map(
                (verification?.skills ?? []).map((skill) => [skill.canonicalName, skill.name]),
            );
            const commandsResult = verification?.skills.length && typeof query.supportedCommands === "function"
                ? await query.supportedCommands().then((value) => ({ ok: true as const, value }), () => ({ ok: false as const, value: [] }))
                : { ok: true as const, value: [] };
            if (commandsResult.ok) {
                nativeCommands.splice(0, nativeCommands.length, ...toNativeCommands(harnessId, commandsResult.value, nativeSkillAliases));
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
                target: provisioningTarget(context, harnessId, { authorityId: authority.authorityId, generation: authority.generation }),
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
            claudeOverlays.consumeIfRevision(context, harnessId, staged.desiredRevision);
        }
        streamLoopActive = true;
        void (async () => {
            try {
                for await (const message of query!) {
                    if ("parent_tool_use_id" in message && message.parent_tool_use_id)
                        continue;
                    if (message.type === "system" && message.subtype === "commands_changed") {
                        nativeCommands.splice(0, nativeCommands.length, ...toNativeCommands(harnessId, message.commands, nativeSkillAliases));
                        emit({ type: "runtime/commands-changed", commands: [...nativeCommands] }, message.uuid + ":commands");
                    }
                    const nativeStatus = message.type === "system" && message.subtype === "status"
                        ? message as { status?: string | null; compact_result?: "success" | "failed"; compact_error?: string }
                        : undefined;
                    if (nativeStatus?.status === "compacting" && compaction?.confirm) {
                        // Claude Code took the `/compact`; it finishes in the
                        // background and reports through the status below.
                        const confirm = compaction.confirm;
                        compaction.confirm = undefined;
                        confirm({ kind: "confirmed", value: { completion: "pending" }, receipt: compaction.operationId });
                    }
                    else if (nativeStatus?.status === "requesting" || nativeStatus?.status === "compacting") {
                        // The SDK emits this immediately before the native API
                        // request. That is prompt-admission evidence: do not wait
                        // for the first completed assistant message before the UI
                        // can clear the composer and enter the working state.
                        // A native `/compact` sends no ordinary request until its
                        // summary is done, which outlasts the admission deadline.
                        markAccepted();
                        if (!active && !admission && !compaction) noteUnadmittedLoop();
                    }
                    if (nativeStatus?.compact_result) {
                        if (compaction) finishCompaction(nativeStatus.compact_result, nativeStatus.compact_error);
                        else if (nativeStatus.compact_result === "success") publishCompacted();
                    }
                    if (message.type === "system" && message.subtype === "compact_boundary") {
                        publishCompacted();
                        pendingBoundary = message.uuid;
                        if (compaction) compaction.boundary = true;
                    }
                    if (message.type === "system" && message.subtype === "task_notification") {
                        // Inside a live turn the CLI folds the notification into
                        // that turn. While idle it would start a loop of its own,
                        // which Polyth refuses — so the result reached nobody.
                        // Ask Polyth for a turn instead and stop the native loop.
                        const note = message as TaskNotification;
                        if (!active && !admission && !note.skip_transcript && !note.ambient) {
                            wakeHandedOff = true;
                            if (unadmittedLoop) noteUnadmittedLoop();
                            emit({ type: "runtime/wake-requested", wakeId: note.uuid, reason: "background-task", text: backgroundTaskWakeText(note) }, `${note.uuid}:wake`);
                        }
                    }
                    if (message.type === "prompt_suggestion") {
                        // Not dialogue and not turn content: a presentation
                        // hint for the composer, offered after the turn closed.
                        const suggestion = typeof message.suggestion === "string" ? message.suggestion.trim() : "";
                        if (suggestion) emit({ type: "runtime/prompt-suggestion", suggestion }, `${message.uuid}:suggestion`);
                    }
                    if (message.type === "rate_limit_event") {
                        const info = message.rate_limit_info;
                        if (info.status === "rejected" && info.resetsAt) {
                            pendingRetry = {
                                scope: "rate",
                                resetAt: info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000,
                                retryable: true,
                            };
                            rejectedLimit = pendingRetry;
                        }
                        else if (info.status !== "rejected") rejectedLimit = undefined;
                    }
                    if (message.type === "system" && message.subtype === "init") {
                        nativeModel = anthropicModel(message.model) ?? nativeModel;
                        void query?.supportedCommands?.().then((cmds) => {
                            nativeCommands.splice(0, nativeCommands.length, ...toNativeCommands(harnessId, cmds, nativeSkillAliases));
                            if (nativeCommands.length) emit({ type: "runtime/commands-changed", commands: [...nativeCommands] }, "init:commands");
                        }).catch(() => {});
                    }
                    if (message.type === "stream_event") {
                        const event = message.event as {
                            type?: string;
                            index?: number;
                            message?: { model?: string; usage?: StreamUsage };
                            content_block?: { type?: string; id?: string; name?: string; input?: unknown };
                            delta?: { type?: string; text?: string; thinking?: string };
                            usage?: StreamUsage;
                        };
                        if (event.type === "message_start") {
                            publishCompacted();
                            // A request whose stop never arrived still counts.
                            flushRequestUsage();
                            streamMessageOrdinal += 1;
                            resetStreamParts();
                            nativeModel = anthropicModel(event.message?.model) ?? nativeModel;
                            requestOrdinal = streamMessageOrdinal;
                            requestStartUsage = event.message?.usage ?? {};
                            requestModel = anthropicModel(event.message?.model);
                            markAccepted();
                        }
                        if (event.type === "message_delta" && event.usage && requestStartUsage) {
                            requestEndUsage = { ...requestEndUsage, ...event.usage };
                        }
                        if (event.type === "message_stop") flushRequestUsage();
                        if (event.type === "content_block_start" && typeof event.index === "number") {
                            const block = event.content_block;
                            if (block?.type === "text") streamPartId(event.index);
                            if (block?.type === "thinking") {
                                streamThinkingIndexes.add(event.index);
                                streamPartId(event.index);
                            }
                            if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                                markAccepted();
                                const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
                                    ? block.input as JsonObject
                                    : {};
                                emitAdmitted({ type: "tool/call", callId: block.id, tool: block.name, input, status: "pending" }, `${block.id}:pending`);
                            }
                        }
                        if (event.type === "content_block_delta" && typeof event.index === "number"
                            && event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
                            markAccepted();
                            const partId = streamPartId(event.index);
                            emitAdmitted({ type: "assistant/chunk", partId, text: event.delta.text }, `${active}:stream:${streamEventOrdinal++}`);
                        }
                        if (event.type === "content_block_delta" && typeof event.index === "number"
                            && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
                            markAccepted();
                            streamThinkingIndexes.add(event.index);
                            const partId = streamPartId(event.index);
                            emitAdmitted({ type: "assistant/reasoning-chunk", partId, text: event.delta.thinking }, `${active}:stream:${streamEventOrdinal++}`);
                        }
                    }
                    if (message.type === "assistant" && message.message.model === SYNTHETIC_MODEL_ID) {
                        markAccepted();
                        // A limit the CLI already knew about: no new
                        // rate_limit_event, only this message. Without a known
                        // reset the server's fallback backoff paces the resends.
                        if (message.error === "rate_limit" && !pendingRetry) {
                            pendingRetry = rejectedLimit?.resetAt && rejectedLimit.resetAt > Date.now()
                                ? rejectedLimit
                                : { scope: "rate", retryable: true };
                        }
                        for (const [index, block] of message.message.content.entries()) {
                            if (block.type === "text" && block.text) syntheticNotices.push({ key: `${message.uuid}:${index}`, text: block.text });
                        }
                    }
                    else if (message.type === "assistant") {
                        nativeModel = anthropicModel(message.message.model) ?? nativeModel;
                        markAccepted();
                        flushSyntheticNotices();
                        const body = message.message.content;
                        const textBlocks: Array<{ index: number; text: string }> = [];
                        const thinkingBlocks: Array<{ index: number; thinking: string }> = [];
                        for (let i = 0; i < body.length; i++) {
                            const block = body[i]!;
                            if (block.type === "text") textBlocks.push({ index: i, text: block.text });
                            if (block.type === "thinking") thinkingBlocks.push({ index: i, thinking: block.thinking });
                            if (block.type === "tool_use"
                                && emitAdmitted({ type: "tool/started", callId: block.id, tool: block.name, input: block.input as JsonObject }, block.id + ":start")) {
                                const snapshot = todos.call(block.id, block.name, block.input);
                                if (snapshot) emit(snapshot, block.id + ":todos");
                            }
                        }
                        // Like text blocks, thinking may arrive in a per-block
                        // assistant snapshot whose local body index differs from
                        // its original stream index. Pair by block order when the
                        // snapshot contains the complete streamed set.
                        const streamedThinking = streamThinkingPartIds();
                        const reuseAllThinking = thinkingBlocks.length > 0 && thinkingBlocks.length === streamedThinking.length;
                        for (const [n, block] of thinkingBlocks.entries()) {
                            const streamedId = reuseAllThinking
                                ? streamedThinking[n]
                                : streamedThinking.find((id) => !finalizedStreamPartIds.has(id));
                            const key = streamedId ?? `${message.uuid}:${block.index}`;
                            if (streamedId) finalizedStreamPartIds.add(streamedId);
                            emitAdmitted({ type: "assistant/message", partId: key, text: "", reasoning: block.thinking }, key);
                        }
                        // The CLI emits one assistant message per completed content
                        // block while streaming. That snapshot often contains only
                        // the text block, so body index 0 is not the Anthropic
                        // stream index (thinking/redacted thinking usually landed
                        // at 0). Pair text blocks with streamed text part IDs in
                        // order, otherwise the timeline keeps the live row and
                        // appends a second finalized copy of the same answer.
                        const streamed = streamTextPartIds();
                        const reuseAll = textBlocks.length > 0 && textBlocks.length === streamed.length;
                        for (const [n, block] of textBlocks.entries()) {
                            const streamedId = reuseAll
                                ? streamed[n]
                                : streamed.find((id) => !finalizedStreamPartIds.has(id));
                            const key = streamedId ?? `${message.uuid}:${block.index}`;
                            if (streamedId) finalizedStreamPartIds.add(streamedId);
                            emitAdmitted({ type: "assistant/message", partId: key, text: block.text }, key);
                        }
                    }
                    if (message.type === "user" && pendingBoundary) {
                        const summary = claudeCompactSummary(message.message.content);
                        if (summary) publishCompacted(summary);
                    }
                    if (message.type === "user" && Array.isArray(message.message.content)) {
                        const results = message.message.content.filter((block) => block.type === "tool_result");
                        // The SDK's typed output describes the message's single tool result.
                        const structured = results.length === 1 ? (message as { tool_use_result?: unknown }).tool_use_result : undefined;
                        for (const block of message.message.content) {
                            if (block.type !== "tool_result") continue;
                            const admitted = emitAdmitted(block.is_error ? { type: "tool/error", callId: block.tool_use_id, tool: "tool", error: "Tool failed" } : { type: "tool/result", callId: block.tool_use_id, tool: "tool", output: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? []) }, block.tool_use_id + ":result");
                            const snapshot = admitted && !block.is_error ? todos.result(block.tool_use_id, block.content, structured) : undefined;
                            if (snapshot) emit(snapshot, block.tool_use_id + ":todos");
                        }
                    }
                    if (message.type === "result" && compaction) {
                        // The `/compact` command's own close. Its tokens stay in
                        // the running total, so the next turn's result reports
                        // them; it is not a turn and stops none.
                        const errorText = message.is_error
                            ? (message as { errors?: string[] }).errors?.[0]
                            : (message as { result?: string }).result;
                        finishCompaction(compaction.boundary && !message.is_error ? "success" : "failed", errorText);
                        publishCompacted();
                        compaction = undefined;
                        requestStartUsage = undefined;
                        requestEndUsage = undefined;
                        streamedUsage = undefined;
                        continue;
                    }
                    if (message.type === "result") {
                        publishCompacted();
                        markAccepted();
                        flushRequestUsage();
                        const turnId = active;
                        const resultId = message.uuid;
                        if (message.modelUsage && resultId !== lastResultId) {
                            const cumulative = usageFromModelUsage(message.modelUsage);
                            // `modelUsage` is the running total for the streaming
                            // query. Any counter dropping means the total restarted
                            // (a `/clear` or a fresh/resumed query), so the snapshot
                            // itself is the new baseline. An all-zero snapshot after
                            // real usage is the SDK's crash/startup-error sample, not
                            // a restart: it is published as an authoritative zero but
                            // must not replace the baseline, or the next result would
                            // republish every token counted before it.
                            const syntheticZero = lastUsage !== undefined && usageIsEmpty(cumulative) && !usageIsEmpty(lastUsage);
                            const rebased = lastUsage !== undefined && usageRegressed(cumulative, lastUsage);
                            const tokens = rebased || syntheticZero ? cumulative : deltaTokenUsage(lastUsage, cumulative);
                            const cost = rebased ? message.total_cost_usd : deltaCost(lastCost, message.total_cost_usd);
                            if (!syntheticZero) {
                                lastUsage = cumulative;
                                lastCost = message.total_cost_usd;
                            }
                            lastResultId = resultId;
                            // Requests already reported while the turn ran are
                            // part of this total; publish only what they missed.
                            const streamed = streamedUsage;
                            streamedUsage = undefined;
                            const remainder = streamed ? deltaTokenUsage(streamed, tokens) : tokens;
                            // Emitted before `active` is released: the sample
                            // belongs to the turn that is closing. It sums many
                            // requests, so it is not a context-occupancy sample.
                            if (!streamed || !usageIsEmpty(remainder) || cost !== undefined) {
                                emitAdmitted({
                                    type: "usage/recorded",
                                    model: nativeModel ?? { providerID: "anthropic", modelID: "unknown" },
                                    tokens: remainder,
                                    aggregate: true,
                                    ...(cost !== undefined ? { cost, costSource: "derived" } : {}),
                                }, resultId + ":usage");
                            }
                        }
                        order++;
                        probeContext(true);
                        probeTitle();
                        const errorText = message.is_error && message.subtype !== "success"
                            ? ((message as { errors?: string[] }).errors?.[0] ?? "Claude Code turn failed")
                            : undefined;
                        const authFailed = Boolean(errorText && /authentication_failed/i.test(errorText));
                        // A stale shared OAuth refresh lock is transient and
                        // resolves on its own; surface it as a bounded retry
                        // instead of a generic unknown failure or a sign-in
                        // prompt. The failed request never reached the model,
                        // so re-sending the last user message is safe.
                        const oauthRefreshLock = Boolean(errorText && CLAUDE_OAUTH_REFRESH_LOCK_RE.test(errorText));
                        // A dropped connection is not a provider limit: a few
                        // quick resends, then an ordinary failure.
                        const transportFailure = Boolean(message.is_error && !pendingRetry && errorText && !authFailed
                            && CLAUDE_TRANSPORT_FAILURE_RE.test(errorText));
                        const retry = message.is_error
                            ? pendingRetry
                                ?? (oauthRefreshLock ? { scope: "unknown" as const, retryAfterSec: 60, retryable: true }
                                    : transportFailure ? { scope: "request" as const, provider: "anthropic", retryable: true }
                                    : undefined)
                            : undefined;
                        pendingRetry = undefined;
                        // The resume notice replaces the CLI's own limit line;
                        // its wording stays on the stop as the error text.
                        const limitNotice = retry ? syntheticNotices.map((notice) => notice.text).join("\n") || undefined : undefined;
                        if (retry) syntheticNotices = [];
                        else flushSyntheticNotices();
                        emitAdmitted({
                            type: "turn/stopped",
                            turnId,
                            reason: message.is_error ? "error" : "completed",
                            ...(retry ? { retry } : {}),
                            ...(message.is_error ? {
                                error: errorText ?? limitNotice,
                                code: authFailed ? "auth-expired" : oauthRefreshLock || transportFailure ? "unknown" : retry ? "rate-limited" : /rate.?limit|overloaded/i.test(errorText ?? "") ? "rate-limited" : "unknown",
                            } : {}),
                        }, turnId + ":stop");
                        // `active` names the admitted operation until the turn's
                        // terminal event is out, so the fence can tell this
                        // turn's own close apart from an unadmitted loop.
                        active = "";
                        if (!turnId) settleUnadmittedLoop();
                    }
                }
            }
            catch {
                connected = false;
                if (compaction?.confirm) {
                    compaction.confirm({ kind: "unknown", operationId: compaction.operationId, message: "Claude Code stopped while compacting" });
                }
                compaction = undefined;
                settleUnadmittedLoop();
                wake?.();
                for (const cb of lifecycle)
                    cb({ type: "stream-disconnected", authorityId: authority.authorityId, generation: authority.generation });
            }
            finally {
                settleUnadmittedLoop();
                resolveStreamFinished();
            }
        })();
    };
    const mutate = async <T>(operationId: string, action: () => Promise<T>): Promise<MutationOutcome<T>> => { try {
        return { kind: "confirmed", value: await action() };
    }
    catch (error) {
        // A refusal raised before anything reached Claude Code (a fresh
        // session asked of a runtime whose process is still held) proves
        // nothing happened. As `unknown` it would fence every later epoch
        // recovery of the session and keep its messages queued for good.
        if ((error as { code?: unknown }).code === "unsupported")
            return { kind: "rejected", code: "unsupported", message: error instanceof Error ? error.message : "Claude Code refused the operation" };
        // Keep the native reason with the ledger entry: without it an
        // uncertain operation cannot be diagnosed after the fact.
        const reason = error instanceof Error ? error.message.split("\n", 1)[0]!.trim().slice(0, 160) : "";
        return { kind: "unknown", operationId, message: reason ? `Claude Code did not confirm the operation (${reason})` : "Claude Code did not confirm the operation" };
    } };
    const create: NonNullable<AgentRuntime["createSessionOperation"]> = async (request, operationId) => {
        if (request.sessionId) sid = request.sessionId;
        let variant: string | undefined;
        if (request.model) {
            const cacheIdentity = { executable: claudeExecutable(), authFingerprint };
            let selection = resolveModelSelection(peekClaudeModels(cacheIdentity) ?? [], request.model, harnessId);
            if (!selection.ok) {
                // The warm catalog refused what the picker offered. The picker's
                // list came from a separate read, so the two can disagree when
                // Claude Code updated or the account's model gating changed in
                // between. Re-read the catalog once before refusing; a probe
                // that fails leaves the warm verdict in place.
                invalidateClaudeModelCache(cacheIdentity);
                try {
                    selection = resolveModelSelection(await catalog(), request.model, harnessId);
                } catch { /* discovery unavailable: the warm verdict stands */ }
            }
            if (!selection.ok) return { kind: "rejected", code: selection.code, message: selection.message };
            variant = selection.variant;
        }
        const outcome = await mutate(operationId, async () => { const id = authority.receipts[operationId] ?? randomUUID(); await initialize(id, false, request.model?.modelID, variant); createId = operationId; await authority.receipt(operationId, id); return { backendSessionId: id }; });
        return outcome.kind === "confirmed" ? { ...outcome, receipt: outcome.value.backendSessionId } : outcome;
    };
    /** Live session first (no spawn); otherwise a cached cold probe. */
    const catalog = async (): Promise<ModelDescriptor[]> => {
        if (query) return claudeModelDescriptors(await query.supportedModels());
        return discoverClaudeModels({
            query: sdk.query as Parameters<typeof discoverClaudeModels>[0]["query"],
            cwd: context.cwd,
            executable: claudeExecutable(),
            authFingerprint,
        });
    };
    /** Bring the session's effort and ultracode flags in line with the turn's
     *  selection. Ultracode is separate from effort: switching to it runs at
     *  xhigh, and leaving it clears both the flag and the xhigh override. */
    const applyVariant = async (variant: string | undefined): Promise<void> => {
        const target = claudeVariantFlags(variant);
        const desiredEffort = target.effort ?? null;
        const effortChanged = appliedEffort !== desiredEffort
            && !(appliedEffort === undefined && desiredEffort === null);
        const ultracodeChanged = appliedUltracode !== target.ultracode;
        if (!effortChanged && !ultracodeChanged) return;
        const settings: ClaudeFlagSettings = {
            ...(effortChanged ? { effortLevel: desiredEffort as EffortLevel | null } : {}),
            ...(target.ultracode ? { ultracode: true } : appliedUltracode ? { ultracode: false } : {}),
        };
        await query!.applyFlagSettings(settings);
        appliedEffort = desiredEffort;
        appliedUltracode = target.ultracode;
    };
    const applyWorkspaceRoots = async (directories: string[], force = false): Promise<void> => {
        const applied = appliedWorkspaceDirectories;
        if (!force && applied !== undefined
            && directories.length === applied.length
            && directories.every((directory, index) => directory === applied[index])) return;
        await query!.applyFlagSettings({ permissions: { additionalDirectories: directories } });
        appliedWorkspaceDirectories = [...directories];
    };
    const runtime: AgentRuntime = {
        capabilities: async () => CLAUDE_CAPABILITIES,
        commands: async () => [...nativeCommands],
        models: () => catalog(), agents: async () => [],
        createSessionOperation: create, resetSessionOperation: create,
        async ensureSession(input) { if (input.sessionId) sid = input.sessionId; if (!input.backendSessionId)
            throw Object.assign(new Error("Operation-aware creation required"), { code: "unsupported" }); const info = context.privateSession ? undefined : await sdk.getSessionInfo(input.backendSessionId, { dir: context.cwd }); await initialize(input.backendSessionId, Boolean(info)); return nativeId; },
        // The server polls this list for a native title while a first turn runs,
        // so read Claude's persisted title rather than waiting for a result.
        sessions: async () => Promise.all(Object.entries(authority.receipts).map(async ([operationId, id]) => ({
            id,
            operationId,
            // A receipt is not a semantic title. Use a recognized placeholder
            // so native-title polling cannot suppress canonical/custom naming.
            title: await nativeTitle(id).catch(() => undefined) || (id === nativeId ? lastTitle : "") || "New session",
            createdAt: 0,
            updatedAt: 0,
        }))), history: async () => [],
        async startTurnOperation(request, operationId) {
            if (request.sessionId) sid = request.sessionId;
            if (!query || active)
                return { kind: "rejected", code: "unsupported", message: "Claude Code supports idle turns on its native account" };
            if (compaction)
                return { kind: "rejected", code: "conflict", message: "Claude Code is compacting the conversation" };
            const workspaceAccess = claudeWorkspaceDirectories(context, request.workspace, request.sessionId);
            if (!workspaceAccess.ok)
                return { kind: "rejected", code: "invalid-workspace", message: workspaceAccess.message };
            // Validate model availability and thinking support before changing
            // the native permission allowlist. A rejected selection must not
            // leave a workspace-roots flag application behind.
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
                const selection = resolveModelSelection(available, request.model, harnessId);
                if (!selection.ok) return { kind: "rejected", code: selection.code, message: selection.message };
                selectedVariant = selection.variant;
            }
            // The SDK supports replacing the session flag allowlist. Apply it
            // before admitting the turn so a previous turn's roots cannot
            // remain usable when membership shrinks. Older/fake SDK seams are
            // accepted only for the legacy no-workspace request shape; they
            // never receive additional roots.
            const workspaceRootsNeedApply = request.workspace !== undefined
                || appliedWorkspaceDirectories === undefined
                || appliedWorkspaceDirectories.length > 0;
            if (typeof query.applyFlagSettings === "function") {
                if (workspaceRootsNeedApply) {
                    try {
                        await applyWorkspaceRoots(workspaceAccess.additionalDirectories, request.workspace !== undefined);
                    } catch {
                        return { kind: "rejected", code: "native-failure", message: "Claude Code could not apply the canonical workspace roots." };
                    }
                }
            } else if (workspaceRootsNeedApply) {
                return { kind: "rejected", code: "unsupported", message: "Claude Code cannot safely authorize additional workspace roots." };
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
                await applyVariant(selectedVariant);
            } catch {
                return {
                    kind: "rejected",
                    code: "native-failure",
                    message: "Claude Code did not accept the model or thinking level for this session.",
                };
            }
            if (unadmittedLoop) {
                // Its stream would otherwise land inside this turn and its
                // result would close it before the prompt below even ran.
                void query.interrupt().catch(() => {});
                await Promise.race([unadmittedLoop.settled, new Promise<void>((resolve) => setTimeout(resolve, UNADMITTED_SETTLE_MS).unref?.())]);
            }
            active = operationId;
            wakeHandedOff = false;
            unadmittedEvents = 0;
            streamMessageOrdinal = -1;
            streamEventOrdinal = 0;
            syntheticNotices = [];
            resetStreamParts();
            order++;
            return new Promise(resolve => { admission = () => resolve({ kind: "confirmed", value: { admissionId: operationId }, receipt: operationId }); inputs.push({ type: "user", uuid: operationId as SDKUserMessage["uuid"], session_id: nativeId, parent_tool_use_id: null, message: { role: "user", content: content as SDKUserMessage["message"]["content"] } }); wake?.(); });
        },
        startTurn: async () => { throw new Error("Operation-aware admission required"); },
        /** Claude Code's own `/compact` on the live session: confirmed once it
         *  starts compacting, finished by `session/compacted` (with Claude's
         *  summary when it streams one) or `session/compaction-failed`. */
        async compactOperation(sessionId, operationId) {
            if (sessionId) sid = sessionId;
            if (!query)
                return { kind: "rejected", code: "unsupported", message: "Claude Code has no live session to compact" };
            if (active || admission || compaction)
                return { kind: "rejected", code: "conflict", message: "Claude Code is busy; compact after the current turn" };
            if (unadmittedLoop) {
                void query.interrupt().catch(() => {});
                await Promise.race([unadmittedLoop.settled, new Promise<void>((resolve) => setTimeout(resolve, UNADMITTED_SETTLE_MS).unref?.())]);
            }
            return new Promise((resolve) => {
                compaction = { operationId, confirm: resolve };
                inputs.push({ type: "user", uuid: operationId as SDKUserMessage["uuid"], session_id: nativeId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "/compact" }] } });
                wake?.();
            });
        },
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
        async replyQuestion(_id, requestId, reply) {
            const request = questions.get(requestId);
            if (!request)
                throw Object.assign(new Error("Question no longer pending"), { code: "not-found" });
            questions.delete(requestId);
            if (reply.action === "reject") {
                request.resolve({ behavior: "deny", message: CLAUDE_QUESTION_DISMISSED });
                return;
            }
            request.resolve({ behavior: "allow", updatedInput: { ...request.input, answers: claudeQuestionAnswers(request.questions, reply) } });
        },
        replyQuestionOperation: async (_id, requestId, reply, operationId) => {
            try {
                await runtime.replyQuestion(context.sessionId!, requestId, reply);
                return { kind: "confirmed", value: {} };
            }
            catch (error) {
                if ((error as { code?: unknown }).code === "not-found")
                    return { kind: "rejected", code: "not-found", message: "Question is no longer pending" };
                return { kind: "unknown", operationId, message: "Claude Code did not confirm the question answer" };
            }
        },
        endpoint: async () => endpoint, protocol: async () => "legacy",
        reconcile: async (binding) => { reconciliationOrdinal = binding.reconciliationOrdinal ?? 0; return ({ ...endpoint, backendSessionId: binding.backendSessionId!, reconciliationOrdinal: binding.reconciliationOrdinal ?? 0, state: { value: !connected || nativeId !== binding.backendSessionId ? "unknown" : active ? "running" : "idle", comparison: { domain: authority.authorityId, order: ++order }, ...(createId && !accepted.length ? { causalOperationId: createId } : {}) }, completeness: { events: "partial", permissions: connected ? "complete" : "unverifiable", questions: connected ? "complete" : "unverifiable" }, events, permissions: [...permissions].map(([requestId, p]) => ({ requestId, permission: p.tool, patterns: [p.tool] })), questions: [...questions].map(([requestId, q]) => ({ requestId, questions: q.items })), acceptedOperations: accepted }); },
        releaseExecution: (binding, operationId) => mutate(operationId, async () => { if ((binding.authorityId !== authority.authorityId || binding.generation !== authority.generation) && !authority.releasedAuthorities.some(p => p.authorityId === binding.authorityId && p.generation === binding.generation))
            throw new Error("Authority mismatch"); if (!binding.backendSessionId || binding.backendSessionId !== nativeId)
            throw Object.assign(new Error("release requires the native backend session"), { code: "unknown-session" }); await runtime.dispose(); return { authorityId: binding.authorityId, generation: binding.generation, backendSessionId: binding.backendSessionId }; }),
        onEvent: cb => { listeners.add(cb); return { dispose: () => { listeners.delete(cb); } }; }, onObservation: cb => { observations.add(cb); return { dispose: () => { observations.delete(cb); } }; }, onLifecycle: cb => { lifecycle.add(cb); return { dispose: () => { lifecycle.delete(cb); } }; },
        async dispose() {
            connected = false;
            wake?.();
            // End the SDK query before releasing Polyth's process containment.
            // The containment release SIGKILLs descendants, and killing Claude
            // Code while it holds the shared ~/.claude/.oauth_refresh.lock
            // leaves a stale lock that makes every other Claude Code process
            // (including Polyth's own recovery sessions) fail to refresh for
            // about a minute. Closing the query first ends the native stdin so
            // the CLI can finish an in-flight refresh and release the lock; the
            // bounded wait is only a fallback for a hung or unresponsive native
            // process.
            try {
                query?.close();
                if (query && streamLoopActive) {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        await Promise.race([
                            streamFinished,
                            new Promise<void>((resolve) => {
                                timer = setTimeout(resolve, CLAUDE_SHUTDOWN_GRACE_MS);
                            }),
                        ]);
                    }
                    finally {
                        if (timer) clearTimeout(timer);
                    }
                }
            }
            catch { /* the native process is already gone */ }
            try {
                await authority.close();
            } finally {
                removeClaudeMcpConfigFiles(context, protectedMcpConfigFiles);
                protectedMcpConfigFiles.clear();
            }
        },
    };
    return runtime;
}
