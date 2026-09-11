import type { NativePushClaim, NativePushEnableInput, NativePushStatus } from "./nativePush.ts";

export interface NativePushBridge {
  status(): Promise<NativePushStatus>;
  enable(input: NativePushEnableInput): Promise<NativePushClaim>;
  disable(input: Pick<NativePushEnableInput, "accountId">): Promise<void>;
  setForeground(input: Pick<NativePushEnableInput, "accountId"> & { active: boolean }): Promise<void>;
}

export interface NativePushServer {
  /** Authenticated paired-device route; the server derives the account/Space. */
  status(): Promise<{ enabled: boolean; subscribed: boolean; subscriptionId?: string }>;
  claim(claimToken: string): Promise<{ subscriptionId: string }>;
  unregister(): Promise<void>;
}

export interface NativePushControllerResult {
  status: NativePushStatus;
  claimed?: boolean;
}

/** Semantic registration coordinator. Pending opens are owned separately by
 * the bundled Connection Hub, so this controller has no URL or payload path. */
export class NativePushController {
  private readonly bridge: NativePushBridge;
  private readonly server: NativePushServer;

  constructor(bridge: NativePushBridge, server: NativePushServer) {
    this.bridge = bridge;
    this.server = server;
  }

  async status(): Promise<NativePushStatus> {
    const local = await this.bridge.status();
    if (local.state !== "enabled") return local;
    try {
      const server = await this.server.status();
      return server.enabled && server.subscribed && server.subscriptionId === local.subscriptionId
        ? local
        : { state: "disabled" };
    } catch {
      // A native mapping alone is not authoritative. Never present it as
      // enabled while the authenticated server state cannot be confirmed.
      return { state: "failed", reason: "registration-failed" };
    }
  }

  async enable(input: NativePushEnableInput): Promise<NativePushControllerResult> {
    const claim = await this.bridge.enable(input);
    try {
      const result = await this.server.claim(claim.claimToken);
      if (result.subscriptionId !== claim.subscriptionId) throw new Error("Native push claim did not match its subscription.");
      await this.bridge.setForeground({ accountId: input.accountId, active: true });
      return { status: await this.status(), claimed: true };
    } catch (error) {
      // A claim that cannot be authenticated must not leave a usable mapping.
      // Disable is deliberately best-effort in native code; the original claim
      // remains short-lived and a later explicit user action can retry.
      await this.bridge.disable(input).catch(() => undefined);
      throw error;
    }
  }

  async disable(input: Pick<NativePushEnableInput, "accountId">): Promise<NativePushStatus> {
    await this.bridge.setForeground({ ...input, active: false }).catch(() => undefined);
    // The native mapping owns its relay management capability. Attempt that
    // privacy-preserving revoke concurrently so an unresponsive authenticated
    // server cannot postpone device-side cleanup.
    const [serverResult, nativeResult] = await Promise.allSettled([
      this.server.unregister(),
      this.bridge.disable(input),
    ]);
    if (nativeResult.status === "rejected") throw nativeResult.reason;
    if (serverResult.status === "rejected") throw serverResult.reason;
    return await this.status();
  }

  async setForeground(input: Pick<NativePushEnableInput, "accountId">, active: boolean): Promise<void> {
    await this.bridge.setForeground({ ...input, active });
  }
}
