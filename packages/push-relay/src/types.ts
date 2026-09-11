export const PUSH_KINDS = ["completed", "failed", "question", "permission", "subagent"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type Platform = "ios" | "android";
export type Environment = "sandbox" | "production";

export type ProviderClass = "success" | "permanent" | "auth" | "rate" | "transient" | "config" | "invalid";

export interface ProviderReply {
  status: number;
  /** Provider reason is used only for classification; it is never logged or returned. */
  reason?: string;
}

export interface Destination {
  subscriptionId: string;
  version: number;
  platform: Platform;
  environment?: Environment;
  providerToken: string;
}

export interface DeliveryInput {
  version: 1;
  subscriptionId: string;
  notificationId: string;
  kind: PushKind;
  tag: string;
}

export interface ProviderAdapter {
  deliver(destination: Destination, input: DeliveryInput, signal?: AbortSignal): Promise<ProviderClass>;
  close?(): void;
}

export interface RelayLogEvent {
  subscriptionId?: string;
  provider?: Platform;
  status?: number;
  code: "provider-result" | "storage-failure" | "request-rejected";
  latencyMs?: number;
}

export type RelayLogger = (event: RelayLogEvent) => void;

export class RelayFault extends Error {
  readonly code: "invalid" | "unauthorized" | "not-found" | "rate" | "storage" | "unavailable";

  constructor(code: "invalid" | "unauthorized" | "not-found" | "rate" | "storage" | "unavailable") {
    super(code);
    this.code = code;
  }
}

/** A deliberate fake-transport seam. Only its small classification code escapes it. */
export class ProviderTransportError extends Error {
  readonly code: "goaway" | "network" | "timeout";

  constructor(code: "goaway" | "network" | "timeout") {
    super(code);
    this.code = code;
  }
}
