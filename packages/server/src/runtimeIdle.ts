import { isWorkspaceUnavailableError } from "@polyth/harness-runtime";

export const OPEN_CODE_RUNTIME_IDLE_TTL_MS = 10 * 60_000;

export interface IdleRuntimeEndpointIdentity {
  authorityId: string;
  generation: number;
}

/** Decide whether an idle runtime facade may be reclaimed.
 *
 * Eviction is cleanup, so the safety check must never *start* a provider
 * process to prove identity: an owned runtime's `endpoint()` spawns when its
 * child is stopped. A facade whose workspace directory was removed therefore
 * cannot produce an endpoint at all, and treating that failure as fatal wedges
 * the reclaimer while the same runtime's SSE loop retries the deleted
 * directory forever. With no session binding and no execution there is no live
 * work to protect, so a missing workspace is reclaimable — the pool recreates
 * the runtime on demand in a live workspace. Any other endpoint failure still
 * propagates so a genuine outage is not silently erased. */
export async function idleRuntimeEvictable(options: {
  occupancy: { bindings: number; executions: number };
  liveStreams: number;
  endpoint(): Promise<IdleRuntimeEndpointIdentity>;
  canEvictRuntime(expected: IdleRuntimeEndpointIdentity): Promise<{ safe: boolean }>;
}): Promise<boolean> {
  if (options.occupancy.bindings > 0 || options.occupancy.executions > 0) return false;
  if (options.liveStreams > 0) return false;
  let expected: IdleRuntimeEndpointIdentity;
  try {
    expected = await options.endpoint();
  } catch (error) {
    if (isWorkspaceUnavailableError(error)) return true;
    throw error;
  }
  return (await options.canEvictRuntime(expected)).safe;
}

export interface RuntimeIdleController {
  /** Record synchronous event/subscription activity without wrapping a promise. */
  touch(): void;
  /** Keep an in-flight runtime call alive and invalidate concurrent idle checks. */
  use<T>(action: () => Promise<T>): Promise<T>;
  /** Test/diagnostic seam; the production timer calls the same path. */
  attemptEviction(options?: { ignoreTtl?: boolean; activityVersion?: number }): Promise<boolean>;
  /** Change retention without restarting the process; zero skips the idle wait. */
  configure(idleTtlMs: number): void;
  snapshot(): { lastUsedAt: number; activityVersion: number; activeCalls: number; stopped: boolean };
  /** Stop the idle timer before an explicit server shutdown. */
  stop(): void;
}

export function createRuntimeIdleController(options: {
  /** Zero disables idle retention, but never bypasses the safety proof. */
  idleTtlMs?: number;
  onActivity?(): void;
  withAdmissionBarrier<T>(action: () => Promise<T>): Promise<T>;
  canEvict(): Promise<boolean>;
  evict(): Promise<void>;
  now?: () => number;
  schedule?: (action: () => void, delayMs: number) => DisposableTimer;
}): RuntimeIdleController {
  let idleTtlMs = options.idleTtlMs ?? OPEN_CODE_RUNTIME_IDLE_TTL_MS;
  if (!Number.isFinite(idleTtlMs) || idleTtlMs < 0) {
    throw new RangeError("runtime idle TTL must be a non-negative finite number");
  }
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((action, delayMs) => {
    const timer = setTimeout(action, delayMs);
    timer.unref();
    return { dispose: () => clearTimeout(timer) };
  });
  let lastUsedAt = now();
  let activityVersion = 0;
  let activeCalls = 0;
  let stopped = false;
  let evicting = false;
  let timer: DisposableTimer | undefined;
  let attempt: Promise<boolean> | undefined;

  const arm = (delayMs = idleTtlMs): void => {
    timer?.dispose();
    timer = undefined;
    if (stopped || evicting) return;
    timer = schedule(() => {
      timer = undefined;
      void attemptEviction().catch((error: unknown) => {
        console.warn("[polyth] idle runtime eviction failed", error);
      });
    }, Math.max(1, delayMs));
  };

  const touch = (): void => {
    if (stopped || evicting) return;
    activityVersion += 1;
    lastUsedAt = now();
    arm();
    options.onActivity?.();
  };

  const attemptOnce = async (request: { ignoreTtl?: boolean; activityVersion?: number }): Promise<boolean> => {
    if (stopped || evicting || activeCalls > 0) return false;
    if (request.activityVersion !== undefined && request.activityVersion !== activityVersion) return false;
    const idleFor = now() - lastUsedAt;
    if (!request.ignoreTtl && idleFor < idleTtlMs) {
      arm(idleTtlMs - idleFor);
      return false;
    }
    const evicted = await options.withAdmissionBarrier(async () => {
      if (stopped || evicting || activeCalls > 0) return false;
      if (request.activityVersion !== undefined && request.activityVersion !== activityVersion) return false;
      const checkedVersion = activityVersion;
      if (!await options.canEvict()) return false;
      // Any runtime call or event that raced with the asynchronous safety
      // proof invalidates it. There is no await between this check and the
      // eviction fence, so a newly starting call cannot be killed.
      if (
        stopped
        || evicting
        || activeCalls > 0
        || activityVersion !== checkedVersion
      ) {
        return false;
      }
      evicting = true;
      try {
        await options.evict();
        stopped = true;
        return true;
      } catch (error) {
        evicting = false;
        throw error;
      }
    });
    if (!evicted && !stopped) {
      // Off must not spin while a session or uncertain operation protects
      // this runtime. New activity/unbinding can request an earlier check.
      arm(Math.max(idleTtlMs, 30_000));
    }
    return evicted;
  };

  const attemptEviction: RuntimeIdleController["attemptEviction"] = (request = {}) => {
    if (attempt) {
      // A timer may have checked the TTL just before budget pressure arrived.
      // Joining that check must not lose the pressure request. The follow-up
      // still validates the captured activity version and the full proof.
      return request.ignoreTtl
        ? attempt.then((evicted) => evicted ? true : attemptEviction(request))
        : attempt;
    }
    attempt = attemptOnce(request).finally(() => {
      attempt = undefined;
      if (!timer && !stopped && !evicting) arm(Math.max(idleTtlMs, 30_000));
    });
    return attempt;
  };

  arm();
  return {
    touch,
    configure(value) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError("runtime idle TTL must be a non-negative finite number");
      if (stopped || evicting) return;
      idleTtlMs = value;
      activityVersion += 1; // A policy change invalidates an in-flight safety check.
      arm(Math.max(0, idleTtlMs - (now() - lastUsedAt)));
    },
    snapshot: () => ({ lastUsedAt, activityVersion, activeCalls, stopped }),
    async use<T>(action: () => Promise<T>): Promise<T> {
      if (stopped || evicting) {
        throw Object.assign(new Error("runtime was evicted after becoming idle"), {
          code: "runtime-evicted",
        });
      }
      activeCalls += 1;
      touch();
      try {
        return await action();
      } finally {
        activeCalls -= 1;
        touch();
      }
    },
    attemptEviction,
    stop() {
      stopped = true;
      timer?.dispose();
      timer = undefined;
    },
  };
}

interface DisposableTimer {
  dispose(): void;
}
