import { useEffect, useSyncExternalStore } from "react";
import type { OpenCodePendingResponseDto } from "@polyth/contracts";
import { api } from "./api.ts";

const EMPTY: OpenCodePendingResponseDto = { changes: [], count: 0 };
let snapshot = EMPTY;
const listeners = new Set<() => void>();
let requestId = 0;

const publish = (next: OpenCodePendingResponseDto): void => {
  const same = next.count === snapshot.count
    && next.changes.every((change, index) => {
      const current = snapshot.changes[index];
      return current?.id === change.id && current.kind === change.kind && current.label === change.label;
    });
  if (same) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
};

export async function refreshOpenCodePending(): Promise<void> {
  const id = ++requestId;
  try {
    const next = await api.opencodePending();
    if (id === requestId) publish(next);
  } catch {
    // Keep the last known pending state through transient disconnects.
  }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const current = (): OpenCodePendingResponseDto => snapshot;
const serverSnapshot = (): OpenCodePendingResponseDto => EMPTY;

export function useOpenCodePending(): OpenCodePendingResponseDto {
  const value = useSyncExternalStore(subscribe, current, serverSnapshot);
  useEffect(() => {
    const refresh = () => { void refreshOpenCodePending(); };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("polyth:opencode-pending", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("polyth:opencode-pending", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return value;
}
