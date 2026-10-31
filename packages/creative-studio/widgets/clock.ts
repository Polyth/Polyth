// Playback time lives outside React state: the player writes it every frame,
// the playhead follows it through refs, and components that show derived
// values (the clock text, the scene under the playhead) re-render only when
// their selected value changes. A studio re-render per frame was the cost of
// the previous design.
import { useCallback, useSyncExternalStore } from "react";

export interface PlayClock {
  get(): number;
  set(time: number): void;
  subscribe(listener: () => void): () => void;
}

export function createPlayClock(initial = 0): PlayClock {
  let time = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set(next) {
      if (!Number.isFinite(next) || next === time) return;
      time = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** A primitive derived from the clock; re-renders only when it changes. */
export function useClockValue<T extends string | number | boolean>(clock: PlayClock, select: (time: number) => T): T {
  const read = useCallback(() => select(clock.get()), [clock, select]);
  return useSyncExternalStore(clock.subscribe, read, read);
}
