// Rate-limit auto-resume policy + timer. When a turn fails because the
// provider is rate-limited / out of quota / overloaded, the backend adapter
// tags the `turn/stopped` with a retry hint. The session service turns that
// into a `SessionResumeState` (this planner) and arms a timer (this
// scheduler) that re-sends the last user message when the wait elapses.
//
// Policy per product decision: when the provider tells us how long to wait we
// honour it in full (no ceiling); with no hint we use an escalating backoff so
// a persistently wedged provider can't hot-loop resends. Capacity attempts are
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

  let retryAfterSec = 0;
  let resetAt: number | undefined;

  const colonMatch = text.match(/resets?\s+in\s+(\d{1,2}:\d{2}(?::\d{2})?)/i);
  if (colonMatch?.[1]) {
    const parts = colonMatch[1].split(":").map(Number);
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      retryAfterSec = parts[0]! * 60 + parts[1]!;
    } else if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      retryAfterSec = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
  }

  if (retryAfterSec === 0) {
    const duration = text.match(
      /resets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:s|m|h|d|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days)\s*)+)/i,
    )?.[1];
    if (duration) {
      for (const match of duration.matchAll(
        /(\d+(?:\.\d+)?)\s*(s|m|h|d|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days)/gi,
      )) {
        const value = Number(match[1]);
        const unit = match[2]!.toLowerCase();
        if (unit.startsWith("d")) retryAfterSec += value * 86400;
        else if (unit.startsWith("h")) retryAfterSec += value * 3600;
        else if (unit.startsWith("m")) retryAfterSec += value * 60;
        else retryAfterSec += value;
      }
    }
  }

  if (retryAfterSec === 0) {
    const isoMatch = text.match(/resets?\s+at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i);
    if (isoMatch?.[1]) {
      const ms = Date.parse(isoMatch[1]);
      if (!Number.isNaN(ms)) {
        resetAt = ms;
        retryAfterSec = Math.max(1, Math.ceil((ms - now) / 1000));
      }
    }
  }

  retryAfterSec = Math.ceil(retryAfterSec);

  return {
    scope: "rate",
    ...(resolvedProvider ? { provider: resolvedProvider } : {}),
    ...(retryAfterSec > 0 ? { retryAfterSec } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
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
