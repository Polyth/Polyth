import type {
  ConnectionMetadata,
  PairingAttempt,
  PolythLinkNative,
  ProxyLaunch,
} from "./polythLink.ts";
import type { DiscoveredPolyth, DiscoveryUpdate } from "./discovery.ts";

export type ConnectionPhase =
  | "idle"
  | "loading-trusted-connections"
  | "discovering"
  | "discovery-permission-required"
  | "discovery-empty"
  | "discovery-results"
  | "preparing-pairing"
  | "scanning-qr"
  | "validating-pairing"
  | "pairing"
  | "safety-confirmation"
  | "awaiting-host-approval"
  | "committing"
  | "connected"
  | "switching"
  | "reconnecting"
  | "offline"
  | "unreachable"
  | "revoked"
  | "incompatible"
  | "identity-mismatch"
  | "pairing-expired"
  | "pairing-rejected"
  | "numeric-code-entry"
  | "numeric-code-validating"
  | "numeric-code-rate-limited"
  | "developer-manual-connect"
  | "fatal-error";

export interface ConnectionControllerState {
  phase: ConnectionPhase;
  epoch: number;
  trusted: ConnectionMetadata[];
  discovered: DiscoveredPolyth[];
  activeConnectionId: string | null;
  targetConnectionId: string | null;
  pairingAttempt: PairingAttempt | null;
  error: string | null;
}

export interface DiscoverySession {
  stop(): Promise<void>;
}

export type DiscoveryStarter = (
  onUpdate: (update: DiscoveryUpdate) => void,
) => Promise<DiscoverySession>;

type Listener = (state: ConnectionControllerState) => void;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorCode(cause: unknown): string {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    return cause.code;
  }
  return errorText(cause);
}

function failurePhase(cause: unknown, fallback: ConnectionPhase): ConnectionPhase {
  switch (errorCode(cause)) {
    case "offline":
      return "offline";
    case "device-revoked":
    case "revoked":
      return "revoked";
    case "host-identity-mismatch":
    case "host-identity-unavailable":
      return "identity-mismatch";
    case "pairing-expired":
      return "pairing-expired";
    case "pairing-rejected":
      return "pairing-rejected";
    case "protocol-incompatible":
    case "protocol-version-unsupported":
    case "incompatible":
      return "incompatible";
    case "rate-limited":
    case "pairing-rate-limited":
      return "numeric-code-rate-limited";
    case "transport-unavailable":
    case "transport-protocol-error":
    case "server-unreachable":
      return "unreachable";
    default:
      return fallback;
  }
}

function discoveryPhase(state: DiscoveryUpdate["state"]): ConnectionPhase {
  switch (state) {
    case "empty":
      return "discovery-empty";
    case "results":
      return "discovery-results";
    case "permission-required":
      return "discovery-permission-required";
    case "error":
      return "fatal-error";
    default:
      return "discovering";
  }
}

function discoveryActive(phase: ConnectionPhase): boolean {
  return phase === "discovering" || phase === "discovery-empty" || phase === "discovery-results";
}

export function connectionPhaseBusy(phase: ConnectionPhase): boolean {
  return phase === "loading-trusted-connections"
    || phase === "preparing-pairing"
    || phase === "validating-pairing"
    || phase === "pairing"
    || phase === "awaiting-host-approval"
    || phase === "committing"
    || phase === "switching"
    || phase === "reconnecting"
    || phase === "numeric-code-validating";
}

export class ConnectionController {
  #native: PolythLinkNative;
  #state: ConnectionControllerState;
  #listeners = new Set<Listener>();
  #epoch = 0;
  #physicalActiveConnectionId: string | null = null;
  #connectionQueue: Promise<void> = Promise.resolve();
  #discoverySession: DiscoverySession | null = null;
  #disposed = false;

  constructor(native: PolythLinkNative, initialError?: string) {
    this.#native = native;
    this.#state = {
      phase: "idle",
      epoch: 0,
      trusted: [],
      discovered: [],
      activeConnectionId: null,
      targetConnectionId: null,
      pairingAttempt: null,
      error: initialError || null,
    };
  }

  get state(): ConnectionControllerState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    this.#disposed = true;
    this.#epoch += 1;
    this.#stopDiscoverySession();
    this.#listeners.clear();
  }

  #set(patch: Partial<ConnectionControllerState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #intent(
    phase: ConnectionPhase,
    patch: Partial<ConnectionControllerState> = {},
  ): number {
    if (!discoveryActive(phase)) this.#stopDiscoverySession();
    const epoch = ++this.#epoch;
    this.#set({
      phase,
      epoch,
      error: null,
      targetConnectionId: null,
      ...patch,
    });
    return epoch;
  }

  #current(epoch: number): boolean {
    return !this.#disposed && epoch === this.#epoch;
  }

  #stopDiscoverySession(): void {
    const session = this.#discoverySession;
    this.#discoverySession = null;
    if (session) void session.stop().catch(() => undefined);
  }

  #enqueueConnection<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#connectionQueue.then(operation, operation);
    this.#connectionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async loadTrustedConnections(): Promise<void> {
    const epoch = this.#intent("loading-trusted-connections");
    try {
      const trusted = await this.#native.listConnections();
      const statuses = await Promise.all(trusted.map(async (connection) => {
        try {
          return await this.#native.getStatus(connection.id);
        } catch {
          return undefined;
        }
      }));
      if (!this.#current(epoch)) return;
      const active = trusted.find((_, index) => statuses[index]?.state === "connected")?.id ?? null;
      this.#physicalActiveConnectionId = active;
      this.#set({
        phase: "idle",
        trusted,
        activeConnectionId: active,
      });
    } catch (cause) {
      if (!this.#current(epoch)) return;
      this.#set({
        phase: failurePhase(cause, "fatal-error"),
        error: errorText(cause),
      });
    }
  }

  async startDiscovery(starter: DiscoveryStarter): Promise<void> {
    this.#stopDiscoverySession();
    const epoch = this.#intent("discovering", { discovered: [] });
    try {
      const session = await starter((update) => {
        if (!this.#current(epoch)) return;
        const phase = discoveryPhase(update.state);
        this.#set({ phase, discovered: update.results, error: update.error ?? null });
        if (!discoveryActive(phase)) this.#stopDiscoverySession();
      });
      if (!this.#current(epoch) || !discoveryActive(this.#state.phase)) {
        await session.stop().catch(() => undefined);
        return;
      }
      this.#discoverySession = session;
    } catch (cause) {
      if (!this.#current(epoch)) return;
      const code = errorCode(cause);
      this.#set({
        phase: code === "discovery-permission-denied"
          ? "discovery-permission-required"
          : "fatal-error",
        discovered: [],
        error: code,
      });
    }
  }

  stopDiscovery(): void {
    this.#intent("idle", { discovered: [] });
  }

  startQrScan(): number {
    return this.#intent("scanning-qr", { pairingAttempt: null });
  }

  cancelQrScan(epoch: number): void {
    if (!this.#current(epoch)) return;
    this.#intent("idle");
  }

  failQrScan(epoch: number, cause: unknown): void {
    if (!this.#current(epoch)) return;
    this.#set({ phase: "idle", error: errorText(cause) });
  }

  async acceptQrResult(epoch: number, raw: string, label = "This phone"): Promise<PairingAttempt | undefined> {
    if (!this.#current(epoch)) return undefined;
    return this.beginPairing(raw, label);
  }

  async beginPairing(raw: string, label = "This phone"): Promise<PairingAttempt | undefined> {
    const epoch = this.#intent("validating-pairing", { pairingAttempt: null });
    try {
      await this.#native.parsePairingTicket(raw);
      if (!this.#current(epoch)) return undefined;
      this.#set({ phase: "preparing-pairing" });
      const attempt = await this.#native.beginPairing(raw, label);
      if (!this.#current(epoch)) {
        await this.#native.cancelPairing(attempt.attemptId).catch(() => undefined);
        return undefined;
      }
      this.#set({
        phase: attempt.safetyPhrase?.length ? "safety-confirmation" : "pairing",
        pairingAttempt: attempt,
      });
      return attempt;
    } catch (cause) {
      if (!this.#current(epoch)) return undefined;
      this.#set({
        phase: failurePhase(cause, "idle"),
        error: errorText(cause),
      });
      return undefined;
    }
  }

  async confirmPairing(): Promise<ProxyLaunch | undefined> {
    const attempt = this.#state.pairingAttempt;
    if (!attempt) return undefined;
    const epoch = this.#intent("awaiting-host-approval", { pairingAttempt: attempt });
    try {
      const launch = await this.#native.confirmPairing(attempt.attemptId);
      if (!this.#current(epoch)) {
        if (this.#state.targetConnectionId !== launch.connectionId
          && this.#state.activeConnectionId !== launch.connectionId) {
          await this.#native.disconnect(launch.connectionId).catch(() => undefined);
        }
        return undefined;
      }
      this.#physicalActiveConnectionId = launch.connectionId;
      this.#set({
        phase: "connected",
        activeConnectionId: launch.connectionId,
        pairingAttempt: null,
      });
      return launch;
    } catch (cause) {
      if (!this.#current(epoch)) return undefined;
      this.#set({
        phase: failurePhase(cause, "pairing-rejected"),
        error: errorText(cause),
      });
      return undefined;
    }
  }

  cancelPairing(): void {
    const attempt = this.#state.pairingAttempt;
    const epoch = this.#intent("idle", { pairingAttempt: null });
    if (!attempt) return;
    void this.#native.cancelPairing(attempt.attemptId).catch((cause) => {
      if (this.#current(epoch)) this.#set({ error: errorText(cause) });
    });
  }

  async connect(connectionId: string): Promise<ProxyLaunch | undefined> {
    const connection = this.#state.trusted.find((item) => item.id === connectionId);
    if (!connection) {
      this.#intent("fatal-error", { error: "Unknown trusted connection." });
      return undefined;
    }
    if (connection.revoked || connection.pairingState === "revoked") {
      this.#intent("revoked", { targetConnectionId: connectionId });
      return undefined;
    }
    if (!connection.hasSecureIdentity) {
      this.#intent("identity-mismatch", { targetConnectionId: connectionId });
      return undefined;
    }

    const switching = this.#physicalActiveConnectionId !== null
      && this.#physicalActiveConnectionId !== connectionId;
    const epoch = this.#intent(switching ? "switching" : "reconnecting", {
      targetConnectionId: connectionId,
    });

    return this.#enqueueConnection(async () => {
      if (!this.#current(epoch)) return undefined;
      try {
        const active = this.#physicalActiveConnectionId;
        if (active && active !== connectionId) {
          await this.#native.disconnect(active);
          this.#physicalActiveConnectionId = null;
          if (!this.#current(epoch)) return undefined;
        }

        const launch = await this.#native.connect(connectionId);
        this.#physicalActiveConnectionId = launch.connectionId;
        if (!this.#current(epoch)) {
          if (this.#state.targetConnectionId !== launch.connectionId
            && this.#state.activeConnectionId !== launch.connectionId) {
            await this.#native.disconnect(launch.connectionId).catch(() => undefined);
            if (this.#physicalActiveConnectionId === launch.connectionId) {
              this.#physicalActiveConnectionId = null;
            }
          }
          return undefined;
        }
        this.#set({
          phase: "connected",
          activeConnectionId: launch.connectionId,
          targetConnectionId: null,
        });
        return launch;
      } catch (cause) {
        if (!this.#current(epoch)) return undefined;
        this.#set({
          phase: failurePhase(cause, "unreachable"),
          targetConnectionId: null,
          error: errorText(cause),
        });
        return undefined;
      }
    });
  }

  async disconnectActive(): Promise<void> {
    const connectionId = this.#physicalActiveConnectionId;
    const epoch = this.#intent("idle");
    if (!connectionId) return;
    await this.#enqueueConnection(async () => {
      if (!this.#current(epoch)) return;
      try {
        await this.#native.disconnect(connectionId);
        this.#physicalActiveConnectionId = null;
        if (this.#current(epoch)) this.#set({ activeConnectionId: null });
      } catch (cause) {
        if (this.#current(epoch)) {
          this.#set({ phase: failurePhase(cause, "unreachable"), error: errorText(cause) });
        }
      }
    });
  }

  async forget(connectionId: string): Promise<void> {
    const epoch = this.#intent("loading-trusted-connections", { targetConnectionId: connectionId });
    await this.#enqueueConnection(async () => {
      if (!this.#current(epoch)) return;
      try {
        await this.#native.forgetConnection(connectionId);
        if (this.#physicalActiveConnectionId === connectionId) this.#physicalActiveConnectionId = null;
        if (!this.#current(epoch)) return;
        this.#set({
          phase: "idle",
          trusted: this.#state.trusted.filter((connection) => connection.id !== connectionId),
          activeConnectionId: this.#state.activeConnectionId === connectionId
            ? null
            : this.#state.activeConnectionId,
          targetConnectionId: null,
        });
      } catch (cause) {
        if (!this.#current(epoch)) return;
        this.#set({
          phase: failurePhase(cause, "fatal-error"),
          targetConnectionId: null,
          error: errorText(cause),
        });
      }
    });
  }
}
