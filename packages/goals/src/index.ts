// Goals workflow plugin: a durable objective attached to a session plus a
// small-model auditor that decides keep / done / stuck after every completed
// turn. Pure logic + injected effects (append event, send turn, complete with a
// cheap model) so it is testable without a backend, and so it never reaches
// into the agent loop — it only listens for turn completion and asks the
// SessionService for another turn, exactly as PLAN §12 / EN-spec §14.1 require.
import type { JsonObject, SessionEvent, TokenUsage } from "@polyth/contracts";

export type GoalStatus = "active" | "paused" | "completed" | "stuck" | "stopped";
export type GoalVerdict = "keep" | "done" | "stuck";

export interface GoalState {
  objective: string;
  status: GoalStatus;
  continuations: number;
  maxContinuations: number;
  tokensUsed: number;
  budgetTokens: number;
  lastVerdict?: GoalVerdict;
  lastReason?: string;
  stuckStreak: number;
  updatedAt: number;
}

export interface AttachGoalInput {
  objective: string;
  budgetTokens?: number;
  maxContinuations?: number;
}

export interface GoalDeps {
  /** Append a canonical session event (server persists + broadcasts it). */
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  /** Ask the session service for another turn. */
  send: (sessionId: string, text: string) => Promise<unknown>;
  /** One-shot cheap-model completion, used only by the auditor. */
  complete: (sessionId: string, prompt: string) => Promise<string>;
  now?: () => number;
  /** Text injected as the continuation turn. */
  continuePrompt?: string;
}

export const DEFAULT_BUDGET_TOKENS = 2_000_000;
export const DEFAULT_MAX_CONTINUATIONS = 12;
export const STUCK_STREAK_LIMIT = 3;

function positiveInteger(value: number | undefined, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw Object.assign(new Error(`${field} must be a finite positive integer`), {
      code: "invalid-input",
      field,
    });
  }
  return value;
}

const CONTINUE_PROMPT =
  "Continue working towards the objective. Do the next concrete step yourself; do not ask for confirmation.";

export const auditorPrompt = (objective: string, reply: string): string =>
  [
    "You audit an autonomous coding session. You see ONLY the objective and the agent's latest reply.",
    "Decide whether the objective is finished, whether work should continue, or whether the agent is stuck.",
    "",
    `<objective>\n${objective}\n</objective>`,
    "",
    `<latest_reply>\n${reply.slice(0, 8000)}\n</latest_reply>`,
    "",
    'Answer with ONLY one JSON object: {"verdict":"keep"|"done"|"stuck","reason":"<max 20 words>"}',
    '"done" = objective demonstrably achieved. "stuck" = blocked, looping, or waiting on the user. Otherwise "keep".',
  ].join("\n");

export function parseVerdict(raw: string): { verdict: GoalVerdict; reason: string } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
      const v = String(obj.verdict ?? "").toLowerCase();
      if (v === "keep" || v === "done" || v === "stuck") {
        return { verdict: v, reason: typeof obj.reason === "string" ? obj.reason : "" };
      }
    } catch {
      /* fall through to text sniffing */
    }
  }
  const lower = raw.toLowerCase();
  if (/\bdone\b|\bcompleted?\b/.test(lower)) return { verdict: "done", reason: "text verdict" };
  if (/\bstuck\b|\bblocked\b/.test(lower)) return { verdict: "stuck", reason: "text verdict" };
  return { verdict: "keep", reason: "unparsed auditor reply" };
}

const totalTokens = (t?: TokenUsage): number =>
  t ? (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) : 0;

const snapshot = (g: GoalState): JsonObject => ({
  objective: g.objective,
  status: g.status,
  continuations: g.continuations,
  maxContinuations: g.maxContinuations,
  tokensUsed: g.tokensUsed,
  budgetTokens: g.budgetTokens,
  ...(g.lastVerdict ? { lastVerdict: g.lastVerdict } : {}),
  ...(g.lastReason ? { lastReason: g.lastReason } : {}),
  updatedAt: g.updatedAt,
});

export interface GoalService {
  attach(sessionId: string, input: AttachGoalInput): Promise<GoalState>;
  get(sessionId: string): GoalState | null;
  pause(sessionId: string): Promise<GoalState>;
  resume(sessionId: string): Promise<GoalState>;
  stop(sessionId: string): Promise<void>;
  /** Fold usage into the goal budget. */
  recordUsage(sessionId: string, tokens?: TokenUsage): void;
  /** Called by the server after a turn finished (reason==="completed"). */
  onTurnCompleted(sessionId: string, assistantText: string): Promise<void>;
  /** Rebuild in-memory state from the durable log (server restart). */
  rehydrate(sessionId: string, events: readonly SessionEvent[]): GoalState | null;
  snapshot(state: GoalState): JsonObject;
}

export function createGoalService(deps: GoalDeps): GoalService {
  const now = deps.now ?? (() => Date.now());
  const continueText = deps.continuePrompt ?? CONTINUE_PROMPT;
  const goals = new Map<string, GoalState>();
  const auditing = new Set<string>(); // serialize continuation per session

  const touch = (g: GoalState): GoalState => {
    g.updatedAt = now();
    return g;
  };

  const emit = async (sessionId: string, type: string, g: GoalState, extra: JsonObject = {}) => {
    await deps.append(sessionId, type, { ...snapshot(g), ...extra });
  };

  return {
    async attach(sessionId, input) {
      const objective = input.objective.trim();
      if (!objective) {
        throw Object.assign(new Error("objective is required"), { code: "invalid-input", field: "objective" });
      }
      const state: GoalState = touch({
        objective,
        status: "active",
        continuations: 0,
        maxContinuations: positiveInteger(
          input.maxContinuations,
          "maxContinuations",
          DEFAULT_MAX_CONTINUATIONS,
        ),
        tokensUsed: 0,
        budgetTokens: positiveInteger(input.budgetTokens, "budgetTokens", DEFAULT_BUDGET_TOKENS),
        stuckStreak: 0,
        updatedAt: now(),
      });
      goals.set(sessionId, state);
      await emit(sessionId, "goal/attached", state);
      return state;
    },

    get(sessionId) {
      return goals.get(sessionId) ?? null;
    },

    async pause(sessionId) {
      const g = goals.get(sessionId);
      if (!g) throw new Error("no goal on this session");
      if (g.status === "active") {
        g.status = "paused";
        touch(g);
        await emit(sessionId, "goal/paused", g);
      }
      return g;
    },

    async resume(sessionId) {
      const g = goals.get(sessionId);
      if (!g) throw new Error("no goal on this session");
      if (g.status === "paused" || g.status === "stuck") {
        g.status = "active";
        g.stuckStreak = 0;
        touch(g);
        await emit(sessionId, "goal/resumed", g);
      }
      return g;
    },

    async stop(sessionId) {
      const g = goals.get(sessionId);
      if (!g) return;
      g.status = "stopped";
      touch(g);
      await emit(sessionId, "goal/stopped", g);
      goals.delete(sessionId);
    },

    recordUsage(sessionId, tokens) {
      const g = goals.get(sessionId);
      if (!g) return;
      g.tokensUsed += totalTokens(tokens);
    },

    async onTurnCompleted(sessionId, assistantText) {
      const g = goals.get(sessionId);
      if (!g || g.status !== "active") return;
      if (auditing.has(sessionId)) return;
      auditing.add(sessionId);
      try {
        let verdict: GoalVerdict;
        let reason: string;
        try {
          const raw = await deps.complete(sessionId, auditorPrompt(g.objective, assistantText));
          ({ verdict, reason } = parseVerdict(raw));
        } catch (err) {
          // Auditor failure must never silently continue an autonomous loop.
          verdict = "stuck";
          reason = `auditor error: ${String(err).slice(0, 120)}`;
        }
        g.lastVerdict = verdict;
        g.lastReason = reason;
        g.stuckStreak = verdict === "stuck" ? g.stuckStreak + 1 : 0;
        touch(g);
        // Counters are bumped *before* goal/audit is appended so the durable log
        // alone reconstructs the exact goal state (invariant 4).
        const willContinue =
          verdict === "keep" &&
          g.continuations < g.maxContinuations &&
          g.tokensUsed < g.budgetTokens;
        if (willContinue) g.continuations += 1;
        await emit(sessionId, "goal/audit", g, { verdict, reason });

        if (verdict === "done") {
          g.status = "completed";
          touch(g);
          await emit(sessionId, "goal/completed", g);
          return;
        }
        if (verdict === "stuck" && g.stuckStreak >= STUCK_STREAK_LIMIT) {
          g.status = "stuck";
          touch(g);
          await emit(sessionId, "goal/stuck", g);
          return;
        }
        if (verdict === "stuck") return; // one bad verdict is not enough to stop or to continue

        if (!willContinue) {
          const limit = g.continuations >= g.maxContinuations ? "continuations" : "tokens";
          g.status = "stuck";
          g.lastReason =
            limit === "continuations" ? "continuation limit reached" : "token budget exhausted";
          touch(g);
          await emit(sessionId, "goal/stuck", g, { limit });
          return;
        }
        try {
          await deps.send(sessionId, continueText);
        } catch (err) {
          g.status = "stuck";
          g.lastReason = `continuation failed: ${String(err).slice(0, 120)}`;
          touch(g);
          await emit(sessionId, "goal/stuck", g, { limit: "error" });
        }
      } finally {
        auditing.delete(sessionId);
      }
    },

    rehydrate(sessionId, events) {
      let state: GoalState | null = null;
      for (const ev of events) {
        if (!ev.type.startsWith("goal/")) {
          if (ev.type === "usage/recorded" && state) {
            const tokens = (ev.data as { tokens?: TokenUsage }).tokens;
            state.tokensUsed = Math.max(state.tokensUsed, 0) + totalTokens(tokens);
          }
          continue;
        }
        // Audit-only recovery marker: it proves the objective was re-injected,
        // but must not mutate the goal workflow state during replay.
        if (ev.type === "goal/context-restored") continue;
        const d = ev.data as Partial<GoalState> & { verdict?: GoalVerdict };
        if (ev.type === "goal/attached") {
          state = {
            objective: String(d.objective ?? ""),
            status: "active",
            continuations: Number(d.continuations ?? 0),
            maxContinuations: Number(d.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS),
            tokensUsed: Number(d.tokensUsed ?? 0),
            budgetTokens: Number(d.budgetTokens ?? DEFAULT_BUDGET_TOKENS),
            stuckStreak: 0,
            updatedAt: Number(d.updatedAt ?? ev.time),
          };
          continue;
        }
        if (!state) continue;
        state.continuations = Number(d.continuations ?? state.continuations);
        state.tokensUsed = Number(d.tokensUsed ?? state.tokensUsed);
        state.updatedAt = Number(d.updatedAt ?? ev.time);
        if (d.lastVerdict) state.lastVerdict = d.lastVerdict;
        if (d.lastReason) state.lastReason = d.lastReason;
        if (ev.type === "goal/audit") {
          state.stuckStreak = d.verdict === "stuck" ? state.stuckStreak + 1 : 0;
        } else if (ev.type === "goal/paused") state.status = "paused";
        else if (ev.type === "goal/resumed") {
          state.status = "active";
          state.stuckStreak = 0;
        } else if (ev.type === "goal/completed") state.status = "completed";
        else if (ev.type === "goal/stuck") state.status = "stuck";
        else if (ev.type === "goal/stopped") state = null;
      }
      if (state) goals.set(sessionId, state);
      else goals.delete(sessionId);
      return state;
    },

    snapshot,
  };
}
