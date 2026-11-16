// Live-only liveness of running tool calls (`tool/progress` frames). Never in
// history and never persisted: the store keeps, per session and call, only the
// time THIS client received the newest frame. The frame's own `at` is the
// adapter's clock and is deliberately ignored — comparing it with this
// device's clock would show drift, not silence.
import { useSyncExternalStore } from "react";

const received = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Record that a frame for this call arrived now (client receipt time). */
export function noteToolProgress(sessionId: string, callId: string, receivedAt = Date.now()): void {
  let calls = received.get(sessionId);
  if (!calls) received.set(sessionId, calls = new Map());
  if (calls.get(callId) === receivedAt) return;
  calls.set(callId, receivedAt);
  emit();
}

/** The call finished (result, error, or its turn stopped). */
export function clearToolProgressCall(sessionId: string, callId: string): void {
  const calls = received.get(sessionId);
  if (!calls?.delete(callId)) return;
  if (calls.size === 0) received.delete(sessionId);
  emit();
}

/** The session stopped being watched or its turn ended. */
export function clearToolProgressSession(sessionId: string): void {
  if (received.delete(sessionId)) emit();
}

export function clearToolProgress(): void {
  if (received.size === 0) return;
  received.clear();
  emit();
}

export function toolLastOutputAt(sessionId: string | null | undefined, callId: string): number | undefined {
  return sessionId ? received.get(sessionId)?.get(callId) : undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Client receipt time of the newest frame for this call, if any arrived. */
export function useToolLastOutputAt(sessionId: string | null | undefined, callId: string): number | undefined {
  const read = () => toolLastOutputAt(sessionId, callId);
  return useSyncExternalStore(subscribe, read, read);
}
