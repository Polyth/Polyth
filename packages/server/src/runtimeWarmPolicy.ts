import { DEFAULT_OPENCODE_RUNTIME_POLICY, type Disposable, type OpenCodeRuntimePolicyDto } from "@polyth/contracts";
import { OPEN_CODE_RUNTIME_IDLE_TTL_MS, type RuntimeIdleController } from "./runtimeIdle.ts";

export function openCodeIdleTtlMs(policy: OpenCodeRuntimePolicyDto): number {
  return policy.mode === "off" ? 0 : policy.mode === "keep-warm" ? policy.idleTtlMinutes * 60_000 : OPEN_CODE_RUNTIME_IDLE_TTL_MS;
}

interface Entry {
  spaceId: string;
  controller: RuntimeIdleController;
  occupied(): boolean;
  policy: OpenCodeRuntimePolicyDto;
}

/** Retention policy over the existing physical owner, never a second pool.
 * LRU pressure bypasses only the idle wait; each controller still proves safe
 * release under its admission barrier and fences racing calls/events. */
export function createRuntimeWarmPolicy(options: {
  readPolicy(spaceId: string): OpenCodeRuntimePolicyDto | undefined;
  schedule?(action: () => void): Disposable;
  onError?(): void;
}) {
  const entries = new Map<string, Entry>();
  const acquiring = new Map<string, number>();
  const schedule = options.schedule ?? ((action) => {
    const timer = setTimeout(action, 0);
    timer.unref();
    return { dispose: () => clearTimeout(timer) };
  });
  let stopped = false;
  let timer: Disposable | undefined;
  let flight: Promise<void> | undefined;
  let changedDuringSweep = false;

  const policyFor = (spaceId: string): OpenCodeRuntimePolicyDto => {
    try { return { ...(options.readPolicy(spaceId) ?? DEFAULT_OPENCODE_RUNTIME_POLICY) }; }
    catch { options.onError?.(); return { ...DEFAULT_OPENCODE_RUNTIME_POLICY }; }
  };
  const occupied = (key: string, entry: Entry): boolean =>
    (acquiring.get(key) ?? 0) > 0 || entry.occupied() || entry.controller.snapshot().activeCalls > 0;

  const sweepOnce = async (): Promise<void> => {
    const groups = new Map<string, Array<{ key: string; entry: Entry; snapshot: ReturnType<RuntimeIdleController["snapshot"]> }>>();
    for (const [key, entry] of entries) {
      const snapshot = entry.controller.snapshot();
      if (snapshot.stopped || occupied(key, entry)) continue;
      const candidates = groups.get(entry.spaceId) ?? [];
      candidates.push({ key, entry, snapshot });
      groups.set(entry.spaceId, candidates);
    }
    for (const candidates of groups.values()) {
      candidates.sort((a, b) => a.snapshot.lastUsedAt - b.snapshot.lastUsedAt);
      let remaining = candidates.length;
      for (const candidate of candidates) {
        const limit = candidate.entry.policy.mode === "off" ? 0 : candidate.entry.policy.maxWarmWorkspaces;
        if (stopped || remaining <= limit) break;
        if (entries.get(candidate.key) !== candidate.entry || occupied(candidate.key, candidate.entry)) {
          remaining -= 1;
          continue;
        }
        try {
          await candidate.entry.controller.attemptEviction({ ignoreTtl: true, activityVersion: candidate.snapshot.activityVersion });
        } catch { options.onError?.(); }
        // A denied proof protects this entry, which is outside the idle
        // budget. Continue to the next candidate instead of killing it.
        remaining -= 1;
      }
    }
  };
  const sweep = (): Promise<void> => {
    if (flight) return flight;
    flight = sweepOnce().finally(() => {
      flight = undefined;
      if (changedDuringSweep) { changedDuringSweep = false; requestSweep(); }
    });
    return flight;
  };
  const requestSweep = (): void => {
    if (stopped || timer) return;
    if (flight) { changedDuringSweep = true; return; }
    timer = schedule(() => {
      timer = undefined;
      void sweep().catch(() => options.onError?.());
    });
  };
  return {
    register(key: string, spaceId: string, controller: RuntimeIdleController, isOccupied: () => boolean): Disposable {
      if (stopped) return { dispose() {} };
      if (entries.has(key)) throw new Error("warm runtime key already registered");
      const entry: Entry = { spaceId, controller, occupied: isOccupied, policy: policyFor(spaceId) };
      entries.set(key, entry);
      controller.configure(openCodeIdleTtlMs(entry.policy));
      requestSweep();
      return { dispose: () => { if (entries.get(key) === entry) entries.delete(key); } };
    },
    refresh(spaceId?: string): void {
      for (const entry of entries.values()) {
        if (spaceId !== undefined && entry.spaceId !== spaceId) continue;
        entry.policy = policyFor(entry.spaceId);
        entry.controller.configure(openCodeIdleTtlMs(entry.policy));
      }
      requestSweep();
    },
    activity: requestSweep,
    sweep,
    isAcquiring: (key: string): boolean => (acquiring.get(key) ?? 0) > 0,
    async acquire<T>(key: string, action: () => Promise<T>): Promise<T> {
      acquiring.set(key, (acquiring.get(key) ?? 0) + 1);
      // Acquiring an already-ready facade may race a safety proof that has
      // passed its first occupancy check. Invalidate that proof immediately.
      entries.get(key)?.controller.touch();
      try { return await action(); }
      finally {
        const count = (acquiring.get(key) ?? 1) - 1;
        if (count) acquiring.set(key, count);
        else acquiring.delete(key);
        requestSweep();
      }
    },
    dispose(): void {
      stopped = true;
      timer?.dispose();
      timer = undefined;
      entries.clear();
    },
  };
}
