// F18 client push manager: registers the root-scope service worker, mints a
// PushSubscription against the server's VAPID key, and keeps the server's
// subscription list in sync. Push needs a secure context — https or the
// loopback fallback (localhost counts as secure), otherwise it reports
// unsupported and the in-page notifier remains the only channel.
import { api } from "./api.ts";

export function pushSupported(): boolean {
  return typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    && typeof window !== "undefined"
    && "PushManager" in window
    && window.isSecureContext;
}

/** Why push is unavailable, for the settings hint; null when it works. */
export function pushUnsupportedReason(): string | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "This browser has no service worker support.";
  if (typeof window === "undefined" || !("PushManager" in window)) return "This browser has no Web Push support.";
  if (!window.isSecureContext) return "Push needs a secure context — open Polyth over https or on localhost.";
  return null;
}

function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function pushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function enablePush(): Promise<void> {
  const reason = pushUnsupportedReason();
  if (reason) throw new Error(reason);
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const reg = await navigator.serviceWorker.register("/sw.js");
  const { publicKey } = await api.pushKey();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64uToBytes(publicKey).buffer as ArrayBuffer,
  });
  await api.pushSubscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await pushSubscription();
  if (!sub) return;
  // Server first: if the network call fails the browser subscription stays,
  // and the toggle honestly remains on.
  await api.pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe();
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
