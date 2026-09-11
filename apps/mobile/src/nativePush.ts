import { Capacitor, registerPlugin } from "@capacitor/core";
import { OPAQUE_NATIVE_PUSH_ID, parseNativePushOpen, type NativePushOpen } from "./nativePushPayload.ts";

/** Values which may cross the WebView bridge. Provider and relay credentials
 * deliberately do not have a TypeScript representation in web code. The
 * account id is a binding input from the currently authenticated connection;
 * native obtains Link identities and the server independently verifies it. */
export type NativePushState = "unavailable" | "disabled" | "enabling" | "enabled" | "denied" | "failed";

export interface NativePushStatus {
  state: NativePushState;
  reason?: "firebase-not-configured" | "permission-denied" | "relay-not-configured" | "registration-failed";
  subscriptionId?: string;
}

export interface NativePushEnableInput {
  /** Obtained from the currently authenticated connection; server re-derives authority. */
  accountId: string;
}

export interface NativePushClaim {
  subscriptionId: string;
  claimToken: string;
  claimExpiresAt: number;
}

export { parseNativePushOpen, type NativePushOpen } from "./nativePushPayload.ts";

interface NativePushPlugin {
  getStatus(): Promise<NativePushStatus>;
  enable(options: NativePushEnableInput): Promise<NativePushClaim>;
  disable(options: Pick<NativePushEnableInput, "accountId">): Promise<{ ok: boolean }>;
  consumePendingOpen(): Promise<Partial<NativePushOpen>>;
  setForeground(options: Pick<NativePushEnableInput, "accountId"> & { active: boolean }): Promise<void>;
}

const NativePush = registerPlugin<NativePushPlugin>("PolythPush");
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_-]{22}$/u;
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

function assertOpaque(value: string, name: string): void {
  if (!OPAQUE_NATIVE_PUSH_ID.test(value)) throw new Error(`Invalid native push ${name}.`);
}

function assertClaim(value: NativePushClaim): NativePushClaim {
  if (!SUBSCRIPTION_ID.test(value.subscriptionId)
    || !CLAIM_TOKEN.test(value.claimToken)
    || !Number.isSafeInteger(value.claimExpiresAt)
    || value.claimExpiresAt <= Date.now()) {
    throw new Error("Native push registration returned an invalid claim.");
  }
  return value;
}

/** Native push only replaces the local projection when the native controller
 * says this exact active trusted connection/account has a claimed mapping. */
let nativeProjectionEnabled = false;

export function nativePushLocalProjectionEnabled(): boolean {
  return nativeProjectionEnabled;
}

/** Only authenticated web orchestration may confirm that native and server
 * subscription IDs match. A native mapping by itself never suppresses the
 * local fallback notification path. */
export function setNativePushAuthoritativeProjection(enabled: boolean): void {
  nativeProjectionEnabled = enabled;
}

export function nativePushAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("PolythPush");
}

export async function refreshNativePushStatus(): Promise<NativePushStatus> {
  if (!nativePushAvailable()) {
    nativeProjectionEnabled = false;
    return { state: "unavailable" };
  }
  const status = await NativePush.getStatus();
  // Native state is only half of the authorization decision. Clear any prior
  // projection until the authenticated server confirms the same subscription.
  nativeProjectionEnabled = false;
  return status;
}

export async function enableNativePush(input: NativePushEnableInput): Promise<NativePushClaim> {
  assertOpaque(input.accountId, "account id");
  const claim = assertClaim(await NativePush.enable(input));
  nativeProjectionEnabled = false; // only a successful server claim enables projection.
  return claim;
}

export async function disableNativePush(input: Pick<NativePushEnableInput, "accountId">): Promise<void> {
  assertOpaque(input.accountId, "account id");
  await NativePush.disable(input);
  nativeProjectionEnabled = false;
}

export async function consumeNativePushOpen(): Promise<NativePushOpen | undefined> {
  if (!nativePushAvailable()) return undefined;
  return parseNativePushOpen(await NativePush.consumePendingOpen());
}

export async function setNativePushForeground(
  input: Pick<NativePushEnableInput, "accountId"> & { active: boolean },
): Promise<void> {
  if (!nativePushAvailable()) return;
  assertOpaque(input.accountId, "account id");
  await NativePush.setForeground(input);
}
