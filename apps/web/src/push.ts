// Client push manager: registers the root-scope service worker, mints a
// PushSubscription against the server's VAPID key, and keeps the server's
// subscription list in sync. Push needs a secure context — https or the
// loopback fallback (localhost counts as secure), otherwise it reports
// unsupported and the in-page notifier remains the only channel.
import { api } from "@polyth/session/web-api";
import { tr } from "./i18n/index.ts";

let registeredPushEndpoint: string | null = null;

/** True only after this browser's current PushSubscription has been confirmed
 * by the authenticated server in this page lifetime. Hidden-page local
 * notifications use this to avoid duplicating the service worker delivery. */
export function webPushDeliveryActive(): boolean {
  return registeredPushEndpoint !== null;
}

export function pushSupported(): boolean {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && typeof window !== "undefined"
    && "PushManager" in window
    && window.isSecureContext;
}

/** Why push is unavailable, for the settings hint; null when it works. */
export function pushUnsupportedReason(): string | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return tr("push.noServiceWorker");
  if (typeof window === "undefined" || !("PushManager" in window)) return tr("push.noWebPush");
  if (!window.isSecureContext) return tr("push.secureContextRequired");
  return null;
}

function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Register at app boot so the authenticated SPA is installable even before
 *  push is enabled. Registration itself never asks for notification access. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (
    typeof navigator === "undefined"
    || !("serviceWorker" in navigator)
    || typeof window === "undefined"
    || !window.isSecureContext
  ) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

async function registerPushSubscription(sub: PushSubscription): Promise<void> {
  await api.pushSubscribe(sub.toJSON());
  registeredPushEndpoint = sub.endpoint;
}

/** Re-register an existing browser subscription with the authenticated
 * account/Space. This repairs server-side subscription loss or ownership
 * migrations without prompting or creating a new browser subscription. */
export async function reconcilePushSubscription(): Promise<boolean> {
  if (!pushSupported()) {
    registeredPushEndpoint = null;
    return false;
  }
  const sub = await pushSubscription();
  if (!sub) {
    registeredPushEndpoint = null;
    return false;
  }
  try {
    await registerPushSubscription(sub);
    return true;
  } catch (error) {
    registeredPushEndpoint = null;
    throw error;
  }
}

async function mintPushSubscription(): Promise<PushSubscription> {
  const reg = await registerServiceWorker();
  if (!reg) throw new Error(tr("push.theServiceWorkerCouldNotBeRegistered"));
  const { publicKey } = await api.pushKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64uToBytes(publicKey).buffer as ArrayBuffer,
  });
  await registerPushSubscription(sub);
  return sub;
}

export async function enablePush(): Promise<void> {
  const reason = pushUnsupportedReason();
  if (reason) throw new Error(reason);
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    throw new Error(tr("push.notificationPermissionWasNotGranted"));
  }
  await mintPushSubscription();
}

export interface PushTestResult {
  sent: number;
  /** Subscriptions the push service reported expired (404/410); removed. */
  dropped: number;
  /** Other rejections or network errors; the server log has the reason. */
  failed: number;
  /** This browser's expired subscription was replaced by a fresh one. */
  renewed: boolean;
}

/** One status line for the Settings test row: delivered, then any expired,
 *  failed or renewed subscriptions, so "0 devices" never hides its reason. */
export function describePushTest(r: PushTestResult): string {
  const parts = [r.sent === 1
    ? tr("settings.pages.sentToOneDevice")
    : tr("settings.pages.sentToValueDevices", { count: r.sent })];
  if (r.dropped > 0) parts.push(tr("settings.pages.pushExpiredCount", { count: r.dropped }));
  if (r.failed > 0) parts.push(tr("settings.pages.pushFailedCount", { count: r.failed }));
  if (r.renewed) parts.push(tr("settings.pages.pushSubscriptionRenewed"));
  return parts.join(" · ");
}

/** Settings test send. When the push service reports this browser's own
 *  subscription expired, the browser keeps a subscription that can never be
 *  delivered to again, so it is replaced (no prompt: permission is already
 *  granted) and the test is sent once more to the fresh endpoint. */
export async function sendTestPush(): Promise<PushTestResult> {
  const sub = await pushSubscription();
  const first = await api.pushTest(sub?.endpoint);
  if (!sub || !first.ownDropped) return { sent: first.sent, dropped: first.dropped, failed: first.failed, renewed: false };
  registeredPushEndpoint = null;
  await sub.unsubscribe().catch(() => false);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    throw new Error(tr("push.notificationPermissionWasNotGranted"));
  }
  const fresh = await mintPushSubscription();
  const second = await api.pushTest(fresh.endpoint);
  return {
    sent: second.sent,
    dropped: first.dropped + second.dropped,
    failed: second.failed,
    renewed: !second.ownDropped,
  };
}

export async function disablePush(): Promise<void> {
  const sub = await pushSubscription();
  if (!sub) {
    registeredPushEndpoint = null;
    return;
  }
  // Server first: if the network call fails the browser subscription stays,
  // and the toggle honestly remains on.
  await api.pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe();
  registeredPushEndpoint = null;
}

/** Deep links from the service worker: an existing tab gets a postMessage
 *  instead of a new window. Installed once at boot. */
export function installPushDeepLinks(openSession: (sessionId: string) => Promise<void>): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; sessionId?: string } | null;
    if (d?.type === "polyth:open-session" && d.sessionId) {
      void openSession(d.sessionId).catch(() => {});
    }
  });
}
