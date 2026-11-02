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

export interface NumericPairingInput {
  hostEndpointId: string;
  addresses: string[];
  port?: number | null;
  code: string;
  /** Absent: the native app sends this phone's own device name. */
  label?: string;
}

export interface ConnectionMetadata {
  id: string;
  hostEndpointId: string;
  /** The name to show: this phone's own name for the server, otherwise the
   *  server's. */
  hostLabel: string;
  /** The name the server gives itself (its owner sets it in Polyth Link). */
  serverLabel?: string;
  /** The name given to the server on this phone; empty when there is none. */
  customLabel?: string;
  pairingState?: "prepared" | "active" | "revoked";
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

export type ConnectionRecovery =
  | { state: "connected"; launch: ProxyLaunch }
  | { state: "needs-pairing"; connectionId: string };

export interface PolythLinkNative {
  parsePairingTicket(raw: string): Promise<PairingPreview>;
  /** Without a label the native app sends this phone's own device name. */
  beginPairing(raw: string, label?: string): Promise<PairingAttempt>;
  beginNumericPairing(input: NumericPairingInput): Promise<PairingAttempt>;
  confirmPairing(attemptId: string): Promise<ProxyLaunch>;
  cancelPairing(attemptId: string): Promise<void>;
  listConnections(): Promise<ConnectionMetadata[]>;
  connect(connectionId: string): Promise<ProxyLaunch>;
  recoverConnection(connectionId: string): Promise<ConnectionRecovery>;
  disconnect(connectionId: string): Promise<void>;
  forgetConnection(connectionId: string): Promise<void>;
  /** Names a saved server on this phone only; an empty name goes back to
   *  the server's own. */
  renameConnection(connectionId: string, label: string): Promise<void>;
  getStatus(connectionId: string): Promise<{ state: string; transport?: "direct" | "relay"; reconnecting?: boolean; error?: string }>;
}

class MissingNativeCore implements PolythLinkNative {
  private fail(): never {
    throw Object.assign(new Error("Polyth Link native core is not installed on this build"), { code: "unavailable" });
  }
  parsePairingTicket() { return Promise.reject(this.fail()); }
  beginPairing() { return Promise.reject(this.fail()); }
  beginNumericPairing() { return Promise.reject(this.fail()); }
  confirmPairing() { return Promise.reject(this.fail()); }
  cancelPairing() { return Promise.reject(this.fail()); }
  async listConnections() { return []; }
  connect() { return Promise.reject(this.fail()); }
  recoverConnection() { return Promise.reject(this.fail()); }
  disconnect() { return Promise.resolve(); }
  forgetConnection() { return Promise.resolve(); }
  renameConnection() { return Promise.reject(this.fail()); }
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
