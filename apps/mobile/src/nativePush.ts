import { Capacitor, registerPlugin } from "@capacitor/core";
import { OPAQUE_NATIVE_PUSH_ID, parseNativePushOpen, type NativePushOpen } from "./nativePushPayload.ts";

/** Values which may cross the WebView bridge. The page carries the device's
 * APNs or FCM token to its own server over Polyth Link; that server sends
 * through Polyth's push service. The private content key stays native. The
 * account id is a binding input from the currently authenticated connection;
 * native obtains Link identities and the server independently verifies it. */
export type NativePushState = "unavailable" | "disabled" | "enabling" | "enabled" | "denied" | "failed";

export interface NativePushStatus {
  state: NativePushState;
  reason?: "firebase-not-configured" | "permission-denied" | "relay-not-configured" | "registration-failed";
  subscriptionId?: string;
  /** The current registration, re-sent on foreground so a rotated APNs/FCM
   *  token reaches the server. */
  registration?: NativePushClaim;
}

export interface NativePushEnableInput {
  /** Obtained from the currently authenticated connection; server re-derives authority. */
  accountId: string;
}

/** The device's APNs token (with its environment) or FCM token, filed under a device-made id. */
export interface NativePushClaim {
  subscriptionId: string;
  providerToken: string;
  /** Absent means iOS. */
  platform?: "android";
  environment?: "sandbox" | "production";
  /** Public half of the sealed-content key (docs/mobile/native-push-content.md).
   * The private half stays in native secure storage and never reaches JS. */
  contentKey?: NativePushContentKey;
}

export interface NativePushContentKey {
  p256dh: string;
  auth: string;
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
const P256DH = /^[A-Za-z0-9_-]{87}$/u;
const AUTH_SECRET = /^[A-Za-z0-9_-]{22}$/u;
const PROVIDER_TOKEN = /^[0-9a-f]{64,512}$/u;
const FCM_TOKEN = /^[!-~]{10,4096}$/u;

function decodeBase64Url(value: string): Uint8Array | undefined {
  try {
    const raw = atob(value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  } catch { return undefined; }
}

function validContentKey(value: unknown): value is NativePushContentKey {
  if (!value || typeof value !== "object") return false;
  const { p256dh, auth } = value as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !P256DH.test(p256dh) || !AUTH_SECRET.test(auth)) return false;
  const point = decodeBase64Url(p256dh);
  return point?.length === 65 && point[0] === 0x04 && decodeBase64Url(auth)?.length === 16;
}

function assertOpaque(value: string, name: string): void {
  if (!OPAQUE_NATIVE_PUSH_ID.test(value)) throw new Error(`Invalid native push ${name}.`);
}

/** The registration in `value`, or undefined. An invalid content key is
 *  dropped, not fatal: push still works and shows the generic text. */
export function parseNativePushClaim(value: unknown): NativePushClaim | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { subscriptionId, providerToken, platform, environment, contentKey } = value as Record<string, unknown>;
  if (typeof subscriptionId !== "string" || !SUBSCRIPTION_ID.test(subscriptionId) || typeof providerToken !== "string") return undefined;
  const key = validContentKey(contentKey) ? { contentKey: { p256dh: contentKey.p256dh, auth: contentKey.auth } } : {};
  if (platform === "android") return FCM_TOKEN.test(providerToken) ? { subscriptionId, providerToken, platform, ...key } : undefined;
  if (platform !== undefined || !PROVIDER_TOKEN.test(providerToken) || (environment !== "sandbox" && environment !== "production")) return undefined;
  return { subscriptionId, providerToken, environment, ...key };
}

function assertClaim(value: unknown): NativePushClaim {
  const claim = parseNativePushClaim(value);
  if (!claim) throw new Error("Native push registration returned an invalid token.");
  return claim;
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
  const raw = await NativePush.getStatus();
  // Native state is only half of the authorization decision. Clear any prior
  // projection until the authenticated server confirms the same subscription.
  nativeProjectionEnabled = false;
  const registration = parseNativePushClaim(raw);
  const { providerToken: _token, environment: _environment, platform: _platform, ...status } = raw as NativePushStatus & { providerToken?: unknown; environment?: unknown; platform?: unknown };
  return registration && status.state === "enabled" ? { ...status, registration } : status;
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
