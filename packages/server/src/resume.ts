// Rate-limit auto-resume policy + timer. When a turn fails because the
// provider is rate-limited / out of quota / overloaded, the backend adapter
// tags the `turn/stopped` with a retry hint. The session service turns that
// into a `SessionResumeState` (this planner) and arms a timer (this
// scheduler) that re-sends the last user message when the wait elapses.
//
// Policy per product decision: when the provider tells us how long to wait we
// honour it in full (no ceiling); with no hint we use an escalating backoff so
// a persistently wedged provider can't hot-loop resends. When an adapter only
// classified the failure, the wait the provider stated in the stop's error
// text ("resets in 1h 51m") still counts as told (`withProviderStatedWait`);
// the ladder is for stops that say nothing. Capacity attempts are
// unbounded — the user can always cancel the wait or switch model.
//
// A provider that refuses the request itself (scope "request") is a different
// case: the refusal is usually about this one call, so it is worth a few quick
// retries, but a rejection that survives them is a real failure. That class is
// bounded by REQUEST_RETRY_MAX_ATTEMPTS and never escalates past it.
import type { RateLimitRetryHint, RateLimitScope, SessionResumeState } from "@polyth/contracts";

/** Wait schedule (seconds) used only when the error carried no advised delay.
 *  Indexed by attempt-1, clamped to the last entry. */
export const RESUME_FALLBACK_BACKOFF_SEC = [30, 60, 120, 300, 600, 900] as const;
/** Quick backoff for a refused request (scope "request"). Indexed by
 *  attempt-1: the retries have to land inside the same couple of minutes as
 *  the original attempt or stop. */
export const REQUEST_RETRY_BACKOFF_SEC = [10, 30, 90] as const;
/** Auto-resends allowed for a scope "request" stop before it becomes an
 *  ordinary failure. */
export const REQUEST_RETRY_MAX_ATTEMPTS = 3;
/** Floor for a provider-advised wait so a "0s"/"1s" hint can't spin. */
export const RESUME_MIN_WAIT_SEC = 5;
/** Buffer after an absolute reset timestamp before retrying. */
export const RESUME_RESET_BUFFER_MS = 2000;
/** setTimeout's max delay; longer waits re-arm on the way down. */
const MAX_TIMER_MS = 2_147_483_647;

/** Longest wait a provider's own text can schedule (matches the adapters). */
const MAX_STATED_WAIT_SEC = 30 * 86_400;

const DURATION_UNIT = "(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)";
const DURATION_PART = `\\d+(?:\\.\\d+)?\\s*${DURATION_UNIT}\\b`;
/** `1h 51m`, `2 hours and 5 minutes`, `90s`, `1:51:00` — digits are required,
 *  so "try again in a moment" never becomes a wait. */
const DURATION = `(\\d{1,3}:\\d{2}(?::\\d{2})?|${DURATION_PART}(?:[\\s,]*(?:and\\s+)?${DURATION_PART})*)`;
const STATED_WAIT_RES = [
  new RegExp(`\\b(?:resets?|available again|try again|retry(?:ing)?(?: again)?|retry[-\\s]?after|wait)\\s+in\\s+${DURATION}`, "i"),
  new RegExp(`\\b(?:retry[-\\s]?after|wait|please wait)[:\\s]+${DURATION}`, "i"),
];

const durationSec = (raw: string): number => {
  if (raw.includes(":")) {
    const parts = raw.split(":").map(Number);
    if (!parts.every((n) => Number.isFinite(n))) return 0;
    return parts.length === 3
      ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
      : parts[0]! * 60 + parts[1]!;
  }
  let total = 0;
  for (const match of raw.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT})\\b`, "gi"))) {
    const value = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    if (unit === "ms" || unit.startsWith("milli")) total += value / 1000;
    else if (unit.startsWith("d")) total += value * 86400;
    else if (unit.startsWith("h")) total += value * 3600;
    else if (unit.startsWith("m")) total += value * 60;
    else total += value;
  }
  return total;
};

/**
 * The wait a provider stated in its own error text ("usage limit reached
 * (5-hour, resets in 1h 51m)", "try again in 20s", "resets at
 * 2026-11-13T06:16:00Z"), or undefined when it stated none. Provider-neutral:
 * adapters that only classify the failure still get the real reset time
 * instead of the blind fallback ladder.
 */
export const providerStatedWait = (
  text: string,
  now = Date.now(),
): { retryAfterSec?: number; resetAt?: number } | undefined => {
  for (const re of STATED_WAIT_RES) {
    const raw = text.match(re)?.[1];
    if (!raw) continue;
    const sec = Math.ceil(Math.min(MAX_STATED_WAIT_SEC, durationSec(raw)));
    if (sec > 0) return { retryAfterSec: sec };
  }
  const iso = text.match(/\bresets?\s+at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i)?.[1];
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > now && ms - now <= MAX_STATED_WAIT_SEC * 1000) {
      return { resetAt: ms, retryAfterSec: Math.max(1, Math.ceil((ms - now) / 1000)) };
    }
  }
  return undefined;
};

/** Fill a capacity hint's missing wait from the stop's error text. A wait the
 *  adapter already parsed (structured headers, absolute reset) wins. */
export const withProviderStatedWait = (
  hint: RateLimitRetryHint,
  errorText: string | undefined,
  now = Date.now(),
): RateLimitRetryHint => {
  if (!errorText || hint.retryable === false || hint.scope === "request") return hint;
  if ((hint.retryAfterSec ?? 0) > 0 || (hint.resetAt ?? 0) > 0) return hint;
  const stated = providerStatedWait(errorText, now);
  return stated ? { ...hint, ...stated } : hint;
};

/** Command Code's reserved provider-window notice, emitted as reasoning rather
 * than a terminal `session.error`. This runs server-side too so a restart while
 * the stream is quiet still recovers the wait. */
export const rateLimitNoticeHint = (text: string, now = Date.now()): RateLimitRetryHint | null => {
  const isMarked = /^\s*\[rate-limit\](?:\s|$)/i.test(text);
  const isUsageLimit = /^\s*(?:error:\s*)?you(?:'ve| have) reached (?:your|today's) .*?usage limit/i.test(text);
  if (!isMarked && !isUsageLimit) return null;

  const provider = text.match(/\b(claude|anthropic|openai|gpt|chatgpt|gemini|google)\b/i)?.[1]?.toLowerCase();
  const normalized = provider === "claude" ? "anthropic"
    : provider === "gpt" || provider === "chatgpt" ? "openai"
      : provider === "gemini" ? "google"
        : provider;
  const resolvedProvider = normalized ?? (isUsageLimit || /\bcommand[_\s-]?code\b/i.test(text) ? "commandcode" : undefined);

  return {
    scope: "rate",
    ...(resolvedProvider ? { provider: resolvedProvider } : {}),
    ...providerStatedWait(text, now),
  };
};

export interface PlanResumeInput {
  hint: RateLimitRetryHint;
  /** seq of the user/message that will be re-sent. */
  userMessageSeq: number;
  /** Chain anchor of this retry: the prompt it replays. Defaults to
   *  `userMessageSeq`; an auto-resume resend appends a new (hidden) user
   *  message, so the caller passes the original prompt's seq to keep the
   *  attempt counter counting one chain. */
  anchorSeq?: number;
  /** Canonical session id for resume state derivation. */
  sessionId?: string;
  /** Existing retry state for the SAME chain, when the previous stop was also
   *  an uncleared limit stop — drives the attempt counter. */
  previous?: { attempt: number; userMessageSeq: number };
  now: number;
}

/** Backoff schedule for a hint's scope: a refused request retries quickly
 *  (and stops early), provider capacity waits use the long escalating ladder. */
const backoffLadder = (scope: RateLimitScope): readonly number[] =>
  scope === "request" ? REQUEST_RETRY_BACKOFF_SEC : RESUME_FALLBACK_BACKOFF_SEC;

export const planResume = (
  { hint, userMessageSeq, anchorSeq, previous, now }: PlanResumeInput,
): SessionResumeState | null => {
  if (hint.retryable === false) return null;

  const anchor = anchorSeq ?? userMessageSeq;
  const attempt = previous && previous.userMessageSeq === anchor
    ? previous.attempt + 1
    : 1;
  // A bounded program (provider request errors) gives up after its budget:
  // returning null leaves the stop as an ordinary failure with no resume.
  const maxAttempts = hint.maxAttempts
    ?? (hint.scope === "request" ? REQUEST_RETRY_MAX_ATTEMPTS : undefined);
  if (maxAttempts !== undefined && attempt > maxAttempts) return null;

  const minResumeAt = now + RESUME_MIN_WAIT_SEC * 1000;
  let resumeAt: number;
  let retryAfterSec: number | undefined;
  let resetAt: number | undefined;

  if (typeof hint.resetAt === "number" && hint.resetAt > 0) {
    resetAt = hint.resetAt;
    resumeAt = Math.max(minResumeAt, hint.resetAt + RESUME_RESET_BUFFER_MS);
  } else {
    const hinted = typeof hint.retryAfterSec === "number" && hint.retryAfterSec > 0
      ? hint.retryAfterSec
      : 0;
    if (hinted > 0) {
      retryAfterSec = hinted;
      resumeAt = now + Math.max(RESUME_MIN_WAIT_SEC, hinted) * 1000;
    } else {
      const ladder = backoffLadder(hint.scope);
      const waitSec = ladder[Math.min(attempt - 1, ladder.length - 1)]
        ?? ladder[ladder.length - 1]!;
      resumeAt = now + waitSec * 1000;
    }
  }

  return {
    resumeAt,
    scope: hint.scope,
    ...(hint.provider ? { provider: hint.provider } : {}),
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    attempt,
    userMessageSeq,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
};

export interface ResumeScheduler {
  /** (Re)arm the resend timer for a session. */
  arm(sessionId: string, resumeAt: number): void;
  /** Drop any pending timer for a session. */
  cancel(sessionId: string): void;
  has(sessionId: string): boolean;
  /** Clear every timer (shutdown). */
  stop(): void;
}

export const createResumeScheduler = (deps: {
  fire(sessionId: string): void | Promise<void>;
  now?(): number;
  onError?(sessionId: string, err: unknown): void;
}): ResumeScheduler => {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (sessionId: string): void => {
    const timer = timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  };

  const arm = (sessionId: string, resumeAt: number): void => {
    cancel(sessionId);
    const delay = Math.max(0, resumeAt - now());
    if (delay > MAX_TIMER_MS) {
      const timer = setTimeout(() => arm(sessionId, resumeAt), MAX_TIMER_MS);
      timer.unref?.();
      timers.set(sessionId, timer);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      void Promise.resolve(deps.fire(sessionId)).catch(
        (err: unknown) => deps.onError?.(sessionId, err),
      );
    }, delay);
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  return {
    arm,
    cancel,
    has: (sessionId) => timers.has(sessionId),
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
};
