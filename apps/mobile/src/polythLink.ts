/** High-level native Polyth Link operations. Private keys never cross this boundary. */

export interface PairingPreview {
  hostLabel: string;
  hostFingerprint: string;
  expiresAt: string;
}

export interface PairingAttempt {
  attemptId: string;
  safetyPhrase?: string[];
  state: string;
}

export interface ConnectionMetadata {
  id: string;
  hostEndpointId: string;
  hostLabel: string;
  lastUsedAt: number;
  lastTransport?: "direct" | "relay";
  revoked?: boolean;
  hasSecureIdentity: boolean;
}

export interface ProxyLaunch {
  origin: string;
  bootstrapUrl: string;
  connectionId: string;
}

export interface PolythLinkNative {
  parsePairingTicket(raw: string): Promise<PairingPreview>;
  beginPairing(raw: string, label: string): Promise<PairingAttempt>;
    confirmPairing(attemptId: string): Promise<ProxyLaunch>;
  cancelPairing(attemptId: string): Promise<void>;
  listConnections(): Promise<ConnectionMetadata[]>;
  connect(connectionId: string): Promise<ProxyLaunch>;
  disconnect(connectionId: string): Promise<void>;
  forgetConnection(connectionId: string): Promise<void>;
  getStatus(connectionId: string): Promise<{ state: string; transport?: "direct" | "relay"; error?: string }>;
}

class MissingNativeCore implements PolythLinkNative {
  private fail(): never {
    throw Object.assign(new Error("Polyth Link native core is not installed on this build"), { code: "unavailable" });
  }
  parsePairingTicket() { return Promise.reject(this.fail()); }
  beginPairing() { return Promise.reject(this.fail()); }
  confirmPairing() { return Promise.reject(this.fail()); }
  cancelPairing() { return Promise.reject(this.fail()); }
  async listConnections() { return []; }
  connect() { return Promise.reject(this.fail()); }
  disconnect() { return Promise.resolve(); }
  forgetConnection() { return Promise.resolve(); }
  getStatus() { return Promise.resolve({ state: "unavailable", error: "host-identity-unavailable" }); }
}

let impl: PolythLinkNative = new MissingNativeCore();

export function setPolythLinkNative(next: PolythLinkNative): void {
  impl = next;
}

export function polythLink(): PolythLinkNative {
  return impl;
}

export function nativeLinkAvailable(): boolean {
  return !(impl instanceof MissingNativeCore);
}
