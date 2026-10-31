/** Bounded, single-flight lifecycle work. Reads never enqueue work implicitly. */
export function createSessionJobs(run: (id: string, signal: AbortSignal) => Promise<void>, concurrency = 2, capacity = 128) {
  let disposed = false;
  const jobs = new Map<string, Promise<void>>();
  const pending: Array<{ id: string; resolve(): void; reject(error: unknown): void }> = [];
  const active = new Map<string, AbortController>();
  const pump = () => {
    while (!disposed && active.size < concurrency && pending.length) {
      const job = pending.shift()!;
      // A shared lifetime signal would retain every job's abort listeners
      // until server teardown, even after the jobs and their promises finish.
      const controller = new AbortController();
      active.set(job.id, controller);
      // Clear ownership before exposing settlement: an immediate retry must
      // create a new job, not reuse the rejected promise.
      void Promise.resolve().then(() => run(job.id, controller.signal)).then(() => {
        active.delete(job.id); jobs.delete(job.id); pump(); job.resolve();
      }, (error) => {
        active.delete(job.id); jobs.delete(job.id); pump(); job.reject(error);
      });
    }
  };
  return {
    enqueue(id: string): Promise<void> {
      const existing = jobs.get(id);
      if (existing) return existing;
      if (disposed || jobs.size >= capacity) return Promise.reject(Object.assign(new Error("session lifecycle work unavailable"), { code: "unavailable" }));
      const promise = new Promise<void>((resolve, reject) => { pending.push({ id, resolve, reject }); });
      jobs.set(id, promise);
      pump();
      return promise;
    },
    size: () => jobs.size,
    dispose() {
      disposed = true;
      for (const controller of active.values()) controller.abort();
      for (const job of pending.splice(0)) {
        jobs.delete(job.id);
        job.reject(Object.assign(new Error("session lifecycle work stopped"), { name: "AbortError" }));
      }
    },
  };
}
