export const OPEN_CODE_RUNTIME_IDLE_TTL_MS = 10 * 60_000;

export interface RuntimeIdleController {
  /** Record synchronous event/subscription activity without wrapping a promise. */
  touch(): void;
  /** Keep an in-flight runtime call alive and invalidate concurrent idle checks. */
  use<T>(action: () => Promise<T>): Promise<T>;
  /** Test/diagnostic seam; the production timer calls the same path. */
  attemptEviction(): Promise<boolean>;
  /** Stop the idle timer before an explicit server shutdown. */
  stop(): void;
}

export function createRuntimeIdleController(options: {
  /** Internal policy only. The production pool uses ten minutes. */
  idleTtlMs?: number;
  withAdmissionBarrier<T>(action: () => Promise<T>): Promise<T>;
  canEvict(): Promise<boolean>;
  evict(): Promise<void>;
  now?: () => number;
  schedule?: (action: () => void, delayMs: number) => DisposableTimer;
}): RuntimeIdleController {
  const idleTtlMs = options.idleTtlMs ?? OPEN_CODE_RUNTIME_IDLE_TTL_MS;
  if (!Number.isFinite(idleTtlMs) || idleTtlMs <= 0) {
    throw new RangeError("runtime idle TTL must be a positive finite number");
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
  };

  const attemptOnce = async (): Promise<boolean> => {
    if (stopped || evicting || activeCalls > 0) return false;
    const idleFor = now() - lastUsedAt;
    if (idleFor < idleTtlMs) {
      arm(idleTtlMs - idleFor);
      return false;
    }
    const evicted = await options.withAdmissionBarrier(async () => {
      if (stopped || evicting || activeCalls > 0) return false;
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
      lastUsedAt = now();
      arm();
    }
    return evicted;
  };

  const attemptEviction = (): Promise<boolean> => {
    if (attempt) return attempt;
    attempt = attemptOnce().finally(() => {
      attempt = undefined;
    });
    return attempt;
  };

  arm();
  return {
    touch,
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
