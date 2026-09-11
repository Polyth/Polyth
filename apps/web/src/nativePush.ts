import { activeBrowserAccountId } from "./accountStorage.ts";
import { openSession } from "./init.ts";
import {
  NativePushController,
  disableNativePush,
  enableNativePush,
  nativePushAvailable,
  nativePushLocalProjectionEnabled,
  refreshNativePushStatus,
  setNativePushAuthoritativeProjection,
  setNativePushForeground,
  type NativePushStatus,
} from "@polyth/mobile/native";

const json = (method: string, body?: Record<string, unknown>): RequestInit => ({
  method,
  credentials: "include",
  headers: body ? { "content-type": "application/json" } : undefined,
  ...(body ? { body: JSON.stringify(body) } : {}),
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = await response.json().catch(() => ({})) as T & { error?: unknown };
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}

function controller() {
  return new NativePushController(
    {
      status: refreshNativePushStatus,
      enable: enableNativePush,
      disable: disableNativePush,
      setForeground: setNativePushForeground,
    },
    {
      status: () => request<{ enabled: boolean; subscribed: boolean; subscriptionId?: string }>("/api/native-push", json("GET")),
      claim: (claimToken) => request<{ subscriptionId: string }>("/api/native-push", json("POST", { claimToken })),
      unregister: async () => { await request<{ ok: boolean }>("/api/native-push", json("DELETE")); },
    },
  );
}

async function authoritativeStatus(): Promise<NativePushStatus> {
  try {
    const status = await controller().status();
    setNativePushAuthoritativeProjection(status.state === "enabled");
    return status;
  } catch (error) {
    setNativePushAuthoritativeProjection(false);
    throw error;
  }
}

export function nativePushSettingsAvailable(): boolean {
  return nativePushAvailable();
}

export async function nativePushSettingsStatus(): Promise<NativePushStatus> {
  return await authoritativeStatus();
}

/** Point-of-use flow: native permission/registration → authenticated server
 * claim. A UI toggle becomes enabled only after both halves succeed. */
export async function enableNativePushForCurrentAccount(): Promise<NativePushStatus> {
  try {
    const result = await controller().enable({ accountId: activeBrowserAccountId() });
    setNativePushAuthoritativeProjection(result.status.state === "enabled");
    return result.status;
  } catch (error) {
    setNativePushAuthoritativeProjection(false);
    throw error;
  }
}

export async function disableNativePushForCurrentAccount(): Promise<NativePushStatus> {
  try {
    const status = await controller().disable({ accountId: activeBrowserAccountId() });
    setNativePushAuthoritativeProjection(status.state === "enabled");
    return status;
  } catch (error) {
    setNativePushAuthoritativeProjection(false);
    throw error;
  }
}

/** Called after authenticated account restoration and foreground changes. */
export async function reconcileNativePushForeground(active: boolean): Promise<void> {
  if (!nativePushAvailable()) return;
  const current = activeBrowserAccountId();
  await controller().setForeground({ accountId: current }, active);
  // Status must be refreshed after the native foreground mapping changes;
  // after a process restart the initial status is deliberately disabled.
  await authoritativeStatus();
}

const NATIVE_NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function clearNativePushOpen(): void {
  const clean = new URL(location.href);
  clean.searchParams.delete("nativePushOpen");
  history.replaceState(null, "", `${clean.pathname}${clean.search}${clean.hash}`);
}

/** Run after authenticated project/session restoration. The provider UUID
 * selects only an account-scoped canonical record, never a session directly. */
export async function openPendingNativePushAfterHydration(): Promise<void> {
  if (!nativePushAvailable()) return;
  const notificationId = new URLSearchParams(location.search).get("nativePushOpen");
  if (!notificationId) return;
  if (!NATIVE_NOTIFICATION_ID.test(notificationId)) { clearNativePushOpen(); return; }
  const status = await authoritativeStatus();
  if (status.state === "failed") return; // keep the bounded intent for a retry/reload
  if (status.state !== "enabled" || !nativePushLocalProjectionEnabled()) { clearNativePushOpen(); return; }

  let response: Response;
  try {
    response = await fetch(`/api/notifications/${encodeURIComponent(notificationId)}`, json("GET"));
  } catch {
    return; // transient connectivity: retain the URL intent, create no trust
  }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) clearNativePushOpen();
    return;
  }
  const record = await response.json().catch(() => undefined) as Partial<{ id: string; sessionId: string; projectId: string }> | undefined;
  if (!record || typeof record.id !== "string" || record.id.toLowerCase() !== notificationId.toLowerCase()
    || typeof record.sessionId !== "string" || typeof record.projectId !== "string") {
    clearNativePushOpen();
    return;
  }
  clearNativePushOpen();
  try {
    await openSession(record.sessionId);
    await request("/api/notifications/read", json("POST", { ids: [notificationId] }));
  } catch {
    // Deleted/archived/inaccessible targets fall back to the hydrated home.
  }
}
