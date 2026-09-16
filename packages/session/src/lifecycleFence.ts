export interface LifecycleFence {
  /**
   * Resolve a read only when no lifecycle mutation overlapped it. If a mutation
   * starts while the read is in flight, its result is stale by definition and
   * the read is retried after lifecycle state becomes idle again.
   */
  readStable<T>(read: () => Promise<T>): Promise<T>;
  /** Invalidate in-flight reads for both successful and failed mutations. */
  mutate<T>(mutation: () => Promise<T>): Promise<T>;
}

/**
 * Small generation/idle fence for lifecycle projections.
 *
 * A generation bump alone is insufficient: a read that starts after the start
 * bump but finishes before a long mutation settles could still publish the old
 * projection. The explicit idle barrier covers that interval without polling.
 */
export function createLifecycleFence(): LifecycleFence {
  let generation = 0;
  let activeMutations = 0;
  let resolveIdle: (() => void) | undefined;
  let idle: Promise<void> = Promise.resolve();

  const beginMutation = (): void => {
    if (activeMutations === 0) {
      idle = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
    }
    activeMutations += 1;
    generation += 1;
  };

  const endMutation = (): void => {
    generation += 1;
    activeMutations -= 1;
    if (activeMutations === 0) {
      const settle = resolveIdle;
      resolveIdle = undefined;
      settle?.();
    }
  };

  return {
    async readStable<T>(read: () => Promise<T>): Promise<T> {
      for (;;) {
        if (activeMutations > 0) await idle;
        const observedGeneration = generation;
        const value = await read();
        if (activeMutations === 0 && observedGeneration === generation) return value;
      }
    },

    async mutate<T>(mutation: () => Promise<T>): Promise<T> {
      beginMutation();
      try {
        return await mutation();
      } finally {
        endMutation();
      }
    },
  };
}
