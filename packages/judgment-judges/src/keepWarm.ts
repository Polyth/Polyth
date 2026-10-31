// Keep warm: after a turn, Judgment answers whether the conversation is
// clearly unfinished; code decides whether a few hidden keep-alives pay for
// themselves before the prompt cache expires. Judgment never sends anything:
// this policy does, only for an armed session, within a bounded budget, and
// stops at the first sign that pinging no longer helps.
import { choice, choiceMargin, type JudgmentUseDescriptor } from "@polyth/judgment";
import type { SessionCacheFacts } from "@polyth/usage/session-cache";
import { clipHead, clipTail, type TurnEvidence } from "./evidence.ts";
import type { JudgeContext } from "./builtins.ts";
import { PACKAGE_ID } from "./types.ts";

export { KEEP_ALIVE_PROMPT } from "./types.ts";
export const KEEP_WARM_USE = "judges.keep-warm";

export const KEEP_WARM: JudgmentUseDescriptor = {
  id: KEEP_WARM_USE, packageId: PACKAGE_ID, order: 22,
  title: "Keep the cache warm",
  description: "After each turn, reads the end of the assistant's last message and asks whether the work is clearly unfinished, so you are likely to come back to it.",
  effect: "When it is, Polyth sends a few hidden keep-alives just before the prompt cache expires, only while that costs less than a cold start. Each is a short model turn; any new message, a finished answer or a cache miss stops them.",
  scope: "judges.keep-warm.v1", evidence: "short", defaultEnabled: false,
  params: [
    { id: "threshold", label: "Keep warm when “unfinished” is at least", kind: "probability", default: 0.8 },
    { id: "margin", label: "Clear lead", kind: "probability", default: 0.3,
      hint: "How far “unfinished” must beat the runner-up. Below it nothing is sent." },
    { id: "maxKeepAlives", label: "Keep-alives per pause, at most", kind: "integer", default: 3, min: 1, max: 12, unit: "keep-alives",
      hint: "With a 5-minute cache, 3 keep-alives hold it about 20 minutes after the last answer." },
    { id: "minCachedTokens", label: "Only for caches of at least", kind: "integer", default: 20_000, min: 1_000, max: 1_000_000, unit: "tokens",
      hint: "Small prompts are cheap to re-read; keeping them warm saves little." },
    { id: "dailyLimit", label: "Keep-alives per day, at most", kind: "integer", default: 40, min: 1, max: 500, unit: "keep-alives",
      hint: "For this Space, across all chats." },
  ],
};

const LABELS = {
  unfinished: "The work is not finished: the assistant asks a question, waits for a decision, reports a blocker, or lists steps that still remain.",
  finished: "The request is answered or the work is done; nothing obvious remains for the person to do next.",
  cannot_tell: "The evidence is insufficient to decide.",
} as const;

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export interface KeepWarmParams { maxKeepAlives: number; minCachedTokens: number; dailyLimit: number }
export interface Continuation { probability: number; margin: number; params: KeepWarmParams }

/** Whether the use is on, with its parameters; undefined when it is off. */
export async function keepWarmParams(ctx: Pick<JudgeContext, "judgment" | "space" | "projectId">) {
  const use = await ctx.judgment.resolveUse({ space: ctx.space, projectId: ctx.projectId }, KEEP_WARM_USE);
  if (!use.enabled) return undefined;
  return {
    threshold: num(use.params.threshold, 0.8), margin: num(use.params.margin, 0.3),
    maxKeepAlives: num(use.params.maxKeepAlives, 3), minCachedTokens: num(use.params.minCachedTokens, 20_000),
    dailyLimit: num(use.params.dailyLimit, 40),
  };
}

/** A confident "unfinished", or undefined: failure, low confidence and every other answer mean "do not keep warm". */
export async function judgeContinuation(ctx: JudgeContext, turn: TurnEvidence, params: NonNullable<Awaited<ReturnType<typeof keepWarmParams>>>): Promise<Continuation | undefined> {
  if (!turn.answer.trim()) return undefined;
  const state = {
    lastRequest: clipHead(turn.request, 200),
    lastAnswer: clipTail(turn.answer, 400),
    openTodos: turn.openTodos.length,
  };
  const run = await ctx.judgment.createRun({ space: ctx.space, projectId: ctx.projectId });
  try {
    const result = await run.judge({ scope: KEEP_WARM.scope, state, signal: ctx.signal, metadata: { sessionId: ctx.sessionId },
      questions: { work: choice("Is the work in this conversation clearly unfinished, so the person is likely to continue it?", LABELS) } });
    if (!result.ok) return undefined;
    const answer = result.answers.work;
    const p = answer.probabilities.unfinished, margin = choiceMargin(answer);
    if (answer.value !== "unfinished" || p < params.threshold || margin < params.margin) return undefined;
    return { probability: p, margin, params: { maxKeepAlives: params.maxKeepAlives, minCachedTokens: params.minCachedTokens, dailyLimit: params.dailyLimit } };
  } finally { run.dispose(); }
}

// ---- policy: pure, deterministic -------------------------------------------

/** Cache read and re-write prices as shares of the normal input price
 *  (Anthropic: 0.1× and 1.25×); a keep-alive also pays its own tiny turn. */
const CACHE_READ_PRICE = 0.1;
const CACHE_WRITE_PRICE = 1.25;
const PING_OVERHEAD = 0.02;
/** A warm cache reads at least this share of the prefix the previous request left. */
const MISS_READ_SHARE = 0.5;
/** Ping this long before expiry: at most a minute, at most a fifth of the lifetime. */
const leadMs = (ttlMs: number) => Math.min(60_000, Math.floor(ttlMs * 0.2));

/**
 * Keep-alives one pause may spend: each must be worth its price given the
 * chance the person comes back. Expected saving p × (write − read) must exceed
 * the pings' cost, and the user's cap bounds it further.
 */
export function keepAliveBudget(probability: number, maxKeepAlives: number): number {
  const affordable = Math.floor((probability * (CACHE_WRITE_PRICE - CACHE_READ_PRICE)) / (CACHE_READ_PRICE + PING_OVERHEAD));
  return Math.max(0, Math.min(maxKeepAlives, affordable));
}

export interface ArmedSession {
  sessionId: string;
  spaceId: string;
  /** The completed turn whose answer armed it; a newer turn re-arms from scratch. */
  turnSeq: number;
  probability: number;
  armedAt: number;
  budget: number;
  minCachedTokens: number;
  dailyLimit: number;
  sent: number;
  lastPingAt?: number;
}

export type KeepWarmStop = "no-cache" | "unknown-ttl" | "small-cache" | "expired" | "budget" | "miss";
export type KeepWarmDecision = { action: "ping" } | { action: "wait"; at: number } | { action: "stop"; reason: KeepWarmStop };

/** Whether a cache is worth arming for at all; undefined means yes. */
export function cacheIneligible(facts: SessionCacheFacts | null, minCachedTokens: number): KeepWarmStop | undefined {
  if (!facts) return "no-cache";
  if (facts.health.ttlMs === null) return "unknown-ttl";
  if (facts.health.cachedTokens < minCachedTokens) return "small-cache";
  return undefined;
}

export function planKeepAlive(armed: ArmedSession, facts: SessionCacheFacts | null, now: number): KeepWarmDecision {
  const ineligible = cacheIneligible(facts, armed.minCachedTokens);
  if (ineligible) return { action: "stop", reason: ineligible };
  const { health } = facts!;
  // The previous keep-alive has settled (the controller never plans while one runs): its response must
  // show it read the cache, or pinging is not keeping anything warm.
  if (armed.lastPingAt !== undefined && (health.lastActivityAt < armed.lastPingAt
    || (facts!.previousCached !== undefined && facts!.lastRead < facts!.previousCached * MISS_READ_SHARE))) {
    return { action: "stop", reason: "miss" };
  }
  if (armed.sent >= armed.budget) return { action: "stop", reason: "budget" };
  const expiresAt = health.lastActivityAt + health.ttlMs!;
  if (now >= expiresAt) return { action: "stop", reason: "expired" };
  const dueAt = expiresAt - leadMs(health.ttlMs!);
  return now >= dueAt ? { action: "ping" } : { action: "wait", at: dueAt };
}

// ---- controller ---------------------------------------------------------------

export interface KeepWarmDeps {
  now(): number;
  /** Cache facts from the canonical log; null when the session reported none. */
  facts(sessionId: string): Promise<SessionCacheFacts | null>;
  /** True only when the session is an idle, eligible chat with nothing queued or pending. */
  ready(entry: Readonly<ArmedSession>): Promise<boolean>;
  send(sessionId: string): Promise<void>;
  onError?(error: unknown): void;
}

/** At most this many armed chats; the oldest is dropped first. */
const MAX_ARMED = 200;

export function createKeepWarm(deps: KeepWarmDeps) {
  const armed = new Map<string, ArmedSession>();
  /** Sessions whose current turn is our keep-alive. */
  const pinging = new Set<string>();
  const sentToday = new Map<string, { day: string; count: number }>();
  let flight: Promise<void> | undefined;

  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  const reserve = (entry: ArmedSession, at: number): boolean => {
    const today = day(at), used = sentToday.get(entry.spaceId);
    const count = used?.day === today ? used.count : 0;
    if (count >= entry.dailyLimit) return false;
    sentToday.set(entry.spaceId, { day: today, count: count + 1 });
    return true;
  };

  const tickOnce = async (): Promise<void> => {
    for (const entry of [...armed.values()]) {
      if (armed.get(entry.sessionId) !== entry || pinging.has(entry.sessionId)) continue;
      try {
        const plan = planKeepAlive(entry, await deps.facts(entry.sessionId), deps.now());
        if (plan.action === "stop") { armed.delete(entry.sessionId); continue; }
        if (plan.action === "wait") continue;
        // Busy or waiting on something: skip this tick; the cache is in use or the person is here.
        if (!await deps.ready(entry) || armed.get(entry.sessionId) !== entry) continue;
        if (!reserve(entry, deps.now())) { armed.delete(entry.sessionId); continue; }
        entry.sent += 1;
        entry.lastPingAt = deps.now();
        pinging.add(entry.sessionId);
        await deps.send(entry.sessionId);
      } catch (error) {
        // Never retry an uncertain send: drop the session instead.
        pinging.delete(entry.sessionId);
        armed.delete(entry.sessionId);
        deps.onError?.(error);
      }
    }
  };

  return {
    arm(entry: Omit<ArmedSession, "sent" | "armedAt">): void {
      armed.delete(entry.sessionId);
      pinging.delete(entry.sessionId);
      if (entry.budget <= 0) return;
      armed.set(entry.sessionId, { ...entry, sent: 0, armedAt: deps.now() });
      while (armed.size > MAX_ARMED) armed.delete(armed.keys().next().value!);
    },
    disarm(sessionId: string): void { armed.delete(sessionId); },
    /** The turn that just completed was our keep-alive: it neither re-arms nor counts as work. */
    settlePing(sessionId: string): boolean { return pinging.delete(sessionId); },
    isArmed: (sessionId: string) => armed.has(sessionId),
    get(sessionId: string): Readonly<ArmedSession> | undefined { return armed.get(sessionId); },
    tick(): Promise<void> {
      flight ??= tickOnce().finally(() => { flight = undefined; });
      return flight;
    },
    clear(): void { armed.clear(); pinging.clear(); },
  };
}
export type KeepWarmController = ReturnType<typeof createKeepWarm>;
