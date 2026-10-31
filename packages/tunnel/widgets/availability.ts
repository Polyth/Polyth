import type { TunnelStatusDto } from "@polyth/contracts";

let available = false;
const listeners = new Set<() => void>();

export function polythLinkCapabilityAvailable(): boolean {
  return available;
}

export function setPolythLinkCapabilityAvailable(next: boolean): void {
  if (available === next) return;
  available = next;
  for (const listener of listeners) listener();
}

export function subscribePolythLinkCapability(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function applyTunnelStatusToCapability(status: TunnelStatusDto): boolean {
  const next = Boolean(status.pairingAvailable);
  setPolythLinkCapabilityAvailable(next);
  return next;
}
