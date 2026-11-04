/** Every host notification kind (`NotificationKind` in @polyth/contracts). A
 *  kind missing here is refused as invalid, so people's messages never reached
 *  a phone until `mention` and `message` joined. */
export const PUSH_KINDS = ["completed", "failed", "question", "permission", "subagent", "mention", "message"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type Platform = "ios" | "android";
export type Environment = "sandbox" | "production";
/** What an iOS destination token addresses: the app (alerts) or its one Live
 *  Activity. */
export type Channel = "alert" | "liveactivity";
/** The Live Activity's states (`PolythActivityAttributes.ContentState.state`). */
export const ACTIVITY_STATES = ["needs-approval", "needs-reply", "working", "failed", "done"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

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
  /** Absent means "alert". */
  channel?: Channel;
  providerToken: string;
}

/** A Live Activity update (`ApnsProvider.deliverActivity`). Only enums,
 *  counts and times: the chat's words stay on the device, which draws them
 *  from its own copy. Times are Unix seconds. */
export interface ActivityInput {
  event: "update" | "end";
  state: ActivityState;
  /** Start of the current work, for the system-drawn timer. */
  startedAt?: number;
  /** Other chats waiting for a person / working. */
  waiting: number;
  working: number;
  staleAt: number;
  /** End only: when the final state leaves the Lock Screen. */
  dismissAt?: number;
  /** False sends at APNs priority 5 (a heartbeat outside the update budget). */
  urgent: boolean;
}

export interface DeliveryInput {
  version: 1;
  subscriptionId: string;
  notificationId: string;
  kind: PushKind;
  tag: string;
  /** Opaque device-sealed content (base64url). Never decoded, logged or returned by the relay. */
  sealed?: string;
}

export interface ProviderAdapter {
  deliver(destination: Destination, input: DeliveryInput, signal?: AbortSignal): Promise<ProviderClass>;
  /** Absent: the platform has no Live Activities. */
  deliverActivity?(destination: Destination, input: ActivityInput, signal?: AbortSignal): Promise<ProviderClass>;
  close?(): void;
}

/** All the relay logs: never a token, payload or source address. */
export interface RelayLogEvent {
  provider: Platform;
  status: number;
  code: "alert" | "activity";
  latencyMs: number;
}

export type RelayLogger = (event: RelayLogEvent) => void;

export class RelayFault extends Error {
  readonly code: "invalid" | "not-found" | "rate" | "unavailable";

  constructor(code: "invalid" | "not-found" | "rate" | "unavailable") {
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
