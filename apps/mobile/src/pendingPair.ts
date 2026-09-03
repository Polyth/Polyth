import { isPairingDeepLink } from "./runtime.ts";

let pending: string | undefined;
const listeners = new Set<(url: string) => void>();

export function rememberPendingPairingLink(raw: string): string | undefined {
  const value = raw.trim();
  if (!isPairingDeepLink(value)) return undefined;
  pending = value;
  for (const listener of listeners) listener(value);
  return value;
}

export function peekPendingPairingLink(): string | undefined {
  return pending;
}

export function clearPendingPairingLink(): void {
  pending = undefined;
}

export function subscribePendingPairingLink(listener: (url: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
