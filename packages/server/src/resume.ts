// Rate-limit auto-resume policy + timer. When a turn fails because the
// provider is rate-limited / out of quota / overloaded, the backend adapter
// tags the `turn/stopped` with a retry hint. The session service turns that
// into a `SessionResumeState` (this planner) and arms a timer (this
// scheduler) that re-sends the last user message when the wait elapses.
//
// Policy per product decision: when the provider tells us how long to wait we
// honour it in full (no ceiling); with no hint we use an escalating backoff so
// a persistently wedged provider can't hot-loop resends. Attempts are
// unbounded — the user can always cancel the wait or switch model.
import type { RateLimitRetryHint, SessionResumeState } from "@polyth/contracts";

/** Wait schedule (seconds) used only when the error carried no advised delay.
 *  Indexed by attempt-1, clamped to the last entry. */
export const RESUME_FALLBACK_BACKOFF_SEC = [30, 60, 120, 300, 600, 900] as const;
/** Floor for a provider-advised wait so a "0s"/"1s" hint can't spin. */
export const RESUME_MIN_WAIT_SEC = 5;
/** setTimeout's max delay; longer waits re-arm on the way down. */
export const MAX_TIMER_MS = 2_147_483_647;

export interface PlanResumeInput {
  hint: RateLimitRetryHint;
  /** seq of the user/message that will be re-sent. */
  userMessageSeq: number;
  /** Existing resume state for the SAME message, when the previous stop was
   *  also an uncleared limit stop — drives the attempt counter. */
  previous?: { attempt: number; userMessageSeq: number };
  now: number;
}

export const planResume = (
  { hint, userMessageSeq, previous, now }: PlanResumeInput,
): SessionResumeState => {
  const attempt = previous && previous.userMessageSeq === userMessageSeq
    ? previous.attempt + 1
    : 1;
  const hinted = typeof hint.retryAfterSec === "number" && hint.retryAfterSec > 0
    ? hint.retryAfterSec
    : 0;
  const waitSec = hinted > 0
    ? Math.max(RESUME_MIN_WAIT_SEC, hinted)
    : RESUME_FALLBACK_BACKOFF_SEC[
        Math.min(attempt - 1, RESUME_FALLBACK_BACKOFF_SEC.length - 1)
      ] ?? RESUME_FALLBACK_BACKOFF_SEC[RESUME_FALLBACK_BACKOFF_SEC.length - 1]!;
  return {
    resumeAt: now + waitSec * 1000,
    scope: hint.scope,
    ...(hint.provider ? { provider: hint.provider } : {}),
    ...(hinted > 0 ? { retryAfterSec: hinted } : {}),
    attempt,
    userMessageSeq,
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
