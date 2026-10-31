import type { ErrorDiagnostics } from "@polyth/contracts";

/** One owner per lifecycle, never per session. No mutation is replayed here. */
export function createTransportRecovery(options: {
  verify(): Promise<boolean>;
  recover(): Promise<void>;
  current(): boolean;
  cooldownMs?: number;
  now?: () => number;
}) {
  let flight: Promise<void> | undefined;
  let state: ErrorDiagnostics["recovery"] = "none";
  let nextAttempt = 0;
  let episodes = 0;
  let disposed = false;
  const failedOperations = new Set<string>();
  let overflowed = false;
  const now = options.now ?? Date.now;
  return {
    state: () => state,
    settled: () => flight ?? Promise.resolve(),
    failed(operation = "control"): void {
      if (disposed) return;
      if (failedOperations.size < 32) failedOperations.add(operation.slice(0, 256));
      else if (!failedOperations.has(operation.slice(0, 256))) overflowed = true;
      if (disposed || flight || now() < nextAttempt || !options.current()) return;
      if (episodes >= 3) { state = "blocked"; return; }
      state = "verifying";
      episodes += 1;
      flight = (async () => {
        try {
          const healthy = await options.verify();
          if (disposed || !options.current()) return;
          if (healthy) {
            // A successful cheap probe cannot declare the failed operation healthy.
            state = "degraded";
            return;
          }
          if (disposed || !options.current()) return;
          state = "reconnecting";
          await options.recover();
          if (disposed) return;
          state = await options.verify() ? "degraded" : "blocked";
        } catch {
          if (!disposed) state = "blocked";
        } finally {
          nextAttempt = now() + (options.cooldownMs ?? 5_000);
          flight = undefined;
          if (!disposed && !overflowed && failedOperations.size === 0) { episodes = 0; state = "none"; nextAttempt = 0; }
        }
      })();
    },
    succeeded(operation = "control"): void {
      failedOperations.delete(operation.slice(0, 256));
      if (!flight && !disposed && !overflowed && failedOperations.size === 0) { episodes = 0; state = "none"; }
    },
    dispose(): void { disposed = true; failedOperations.clear(); },
  };
}
