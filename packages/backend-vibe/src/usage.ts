// Per-turn token usage from Vibe's session totals.
//
// Vibe reports usage only as running totals of the whole native session
// (verified against 3.1.5): the `session/prompt` answer carries
// `usage: { inputTokens, outputTokens, cachedReadTokens, totalTokens }` and
// every `usage_update` carries the same counters in `_meta` (`promptTokens`,
// `completionTokens`, `cachedTokens`). The totals survive a restart: a loaded
// session's first `usage_update` already holds everything before it. Its
// on-disk store keeps no per-request record Polyth could read instead.
//
// A turn's usage is therefore its prompt answer minus the totals seen when
// the turn began. Vibe echoes the prompt as `user_message_chunk` before its
// first model request, so the totals last seen at that echo are the turn's
// starting point. With no starting point (an echo that never came) nothing is
// reported rather than a whole session counted as one turn.
import type { TokenUsage } from "@polyth/contracts";

interface Totals { input: number; output: number; cached: number }

const MAX_TRACKED_SESSIONS = 256;

const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The totals of a `usage_update`'s `_meta`, when it has them. */
export const totalsFromUsageUpdate = (update: Record<string, unknown>): Totals | undefined => {
    const meta = record(update._meta);
    const input = count(meta?.promptTokens);
    const output = count(meta?.completionTokens);
    if (input === undefined || output === undefined) return undefined;
    return { input, output, cached: count(meta?.cachedTokens) ?? 0 };
};

/** The totals of a `session/prompt` answer, when it has them. */
export const totalsFromPromptResult = (result: Record<string, unknown> | undefined): Totals | undefined => {
    const usage = record(result?.usage);
    const input = count(usage?.inputTokens);
    const output = count(usage?.outputTokens);
    if (input === undefined || output === undefined) return undefined;
    return { input, output, cached: count(usage?.cachedReadTokens) ?? 0 };
};

export interface VibeTurnUsageTracker {
    /** Every `session/update` of a native session. */
    observe(sessionId: string, update: Record<string, unknown>): void;
    /** When the current turn's prompt echo arrived, if it did. */
    echoedAt(sessionId: string): number | undefined;
    /** The finished turn's own usage, or undefined when it cannot be known. */
    settle(sessionId: string, result: Record<string, unknown> | undefined): TokenUsage | undefined;
}

export function createVibeTurnUsageTracker(now: () => number = Date.now): VibeTurnUsageTracker {
    const latest = new Map<string, Totals>();
    const start = new Map<string, Totals>();
    const echoes = new Map<string, number>();
    const bounded = <V>(map: Map<string, V>, key: string, value: V) => {
        map.delete(key);
        map.set(key, value);
        if (map.size > MAX_TRACKED_SESSIONS) map.delete(map.keys().next().value!);
    };
    return {
        observe(sessionId, update) {
            if (update.sessionUpdate === "usage_update") {
                const totals = totalsFromUsageUpdate(update);
                if (totals) bounded(latest, sessionId, totals);
                return;
            }
            if (update.sessionUpdate === "user_message_chunk") {
                // A loaded session replays its earlier prompts as well; only
                // the last echo before a turn's first model request counts.
                bounded(echoes, sessionId, now());
                const totals = latest.get(sessionId);
                if (totals) bounded(start, sessionId, totals);
                else start.delete(sessionId);
            }
        },
        echoedAt: (sessionId) => echoes.get(sessionId),
        settle(sessionId, result) {
            const before = start.get(sessionId);
            start.delete(sessionId);
            const after = totalsFromPromptResult(result);
            if (after) bounded(latest, sessionId, after);
            if (!before || !after) return undefined;
            const input = after.input - before.input;
            const output = after.output - before.output;
            const cached = Math.max(0, after.cached - before.cached);
            // Totals never shrink within a session; a smaller one is not this
            // session's counter (a reset or a mismatched answer).
            if (input < 0 || output < 0 || (input === 0 && output === 0)) return undefined;
            return {
                input: Math.max(0, input - cached),
                output,
                ...(cached ? { cacheRead: cached } : {}),
            };
        },
    };
}
