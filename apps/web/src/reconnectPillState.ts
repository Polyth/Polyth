import type { SyncStatus } from "./sync.ts";

export const RECONNECT_PILL_DELAY_MS = 3_000;

export interface ReconnectPillState {
  update: (status: SyncStatus) => void;
  visible: () => boolean;
  dispose: () => void;
}

/** Keeps one delay across disconnected → connecting transitions. A reconnect
 * clears the pending timer and visible state immediately. */
export function createReconnectPillState(
  onChange: (visible: boolean) => void,
  delayMs = RECONNECT_PILL_DELAY_MS,
): ReconnectPillState {
  let unhealthy = false;
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (next: boolean) => {
    if (shown === next) return;
    shown = next;
    onChange(next);
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    update(status) {
      const nextUnhealthy = status !== "connected";
      if (!nextUnhealthy) {
        unhealthy = false;
        clearTimer();
        publish(false);
        return;
      }
      if (unhealthy) return;
      unhealthy = true;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        if (unhealthy) publish(true);
      }, delayMs);
    },
    visible: () => shown,
    dispose() {
      unhealthy = false;
      clearTimer();
    },
  };
}
