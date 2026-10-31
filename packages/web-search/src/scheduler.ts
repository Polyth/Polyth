import { webSearchError } from "./errors.ts";

interface QueueEntry<T = unknown> {
  task: () => Promise<T>;
  signal?: AbortSignal;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
  cleanup?: () => void;
}

interface KeyState {
  active: number;
  nextStart: number;
  queue: QueueEntry[];
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export interface SearchScheduler {
  run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  close(): void;
}

export function createSearchScheduler(options: {
  maximumConcurrent?: number;
  minimumIntervalMs?: number;
  maximumQueued?: number;
  /** Noun used in queue errors, e.g. "web search" or "web fetch". */
  label?: string;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}): SearchScheduler {
  const maximumConcurrent = Math.max(1, options.maximumConcurrent ?? 2);
  const minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 250);
  const maximumQueued = Math.max(0, options.maximumQueued ?? 8);
  const label = options.label ?? "web search";
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const states = new Map<string, KeyState>();
  let closed = false;

  const stateFor = (key: string): KeyState => {
    let state = states.get(key);
    if (!state) {
      state = { active: 0, nextStart: 0, queue: [], closed: false };
      states.set(key, state);
    }
    return state;
  };

  const pump = (key: string, state: KeyState): void => {
    if (state.closed) return;
    if (state.timer) {
      clearTimer(state.timer);
      state.timer = undefined;
    }
    while (state.active < maximumConcurrent && state.queue.length > 0) {
      const wait = Math.max(0, state.nextStart - now());
      if (wait > 0) {
        state.timer = setTimer(() => pump(key, state), wait);
        return;
      }
      const entry = state.queue.shift()!;
      if (entry.signal?.aborted) {
        entry.cleanup?.();
        entry.reject(webSearchError("aborted", `${label} was cancelled`));
        continue;
      }
      entry.cleanup?.();
      state.active += 1;
      state.nextStart = now() + minimumIntervalMs;
      void Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          state.active -= 1;
          if (state.queue.length === 0 && state.active === 0) states.delete(key);
          else pump(key, state);
        });
    }
    if (state.active === 0 && state.queue.length === 0) states.delete(key);
  };

  return {
    run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal) {
      if (closed) return Promise.reject(webSearchError("unavailable", `${label} is shutting down`));
      if (signal?.aborted) return Promise.reject(webSearchError("aborted", `${label} was cancelled`));
      const state = stateFor(key);
      if (state.closed) return Promise.reject(webSearchError("unavailable", `${label} is shutting down`));
      if (state.active >= maximumConcurrent && state.queue.length >= maximumQueued) {
        return Promise.reject(webSearchError("rate-limited", `too many ${label} requests are already running`));
      }
      return new Promise<T>((resolve, reject) => {
        const entry: QueueEntry<T> = { task, resolve, reject, ...(signal ? { signal } : {}) };
        if (signal) {
          const cleanup = () => signal.removeEventListener("abort", onAbort);
          const onAbort = () => {
            cleanup();
            const index = state.queue.indexOf(entry as QueueEntry);
            if (index >= 0) state.queue.splice(index, 1);
            entry.reject(webSearchError("aborted", `${label} was cancelled`));
          };
          entry.cleanup = cleanup;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        state.queue.push(entry as QueueEntry);
        pump(key, state);
      });
    },
    close() {
      closed = true;
      for (const [key, state] of states) {
        state.closed = true;
        if (state.timer) clearTimer(state.timer);
        for (const entry of state.queue.splice(0)) {
          entry.cleanup?.();
          entry.reject(webSearchError("unavailable", `${label} is shutting down`));
        }
        if (state.active === 0) states.delete(key);
      }
    },
  };
}
