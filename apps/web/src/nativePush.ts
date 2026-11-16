import { activeBrowserAccountId } from "./accountStorage.ts";
import { hydrateClientRecord, writeClientPreference } from "./clientPersistence.ts";
import { openSession } from "./init.ts";
import { clientAccountPersistenceScope } from "./reliabilityContext.ts";
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
import { landedNativePushOpen, openNativePushTarget, withoutNativePushOpen } from "./nativePushOpen.ts";

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
      // The device's APNs or FCM token, over the Polyth Link connection this
      // page uses; this server sends through Polyth's push service.
      claim: (claim) => request<{ subscriptionId: string }>("/api/native-push", json("POST", { ...claim })),
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

/** Per connection + account: push was on here once, or the user turned it off
 * in Settings. From then on only Settings changes it. */
const SETTLED_KIND = "native-push-settled";

/** After the app connects to a server, ask the OS once and register, so push
 * needs no visit to Settings. A refused prompt is the OS's to remember: later
 * launches see "denied" and never ask again. */
export async function autoEnableNativePush(): Promise<void> {
  if (!nativePushAvailable()) return;
  const scope = clientAccountPersistenceScope();
  if (await hydrateClientRecord(SETTLED_KIND, scope) !== null) return;
  let status = await authoritativeStatus();
  if (status.state === "disabled") status = await enableNativePushForCurrentAccount();
  if (status.state === "enabled") writeClientPreference(SETTLED_KIND, scope, "on");
}

export async function disableNativePushForCurrentAccount(): Promise<NativePushStatus> {
  writeClientPreference(SETTLED_KIND, clientAccountPersistenceScope(), "off");
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
  // Leaving the foreground does not end the registration: the server keeps
  // pushing to this phone. The native side answers "disabled" for a page that
  // is not its foreground account, so reading the status here switched the
  // page's own local notifications back on, and a task that ended before iOS
  // suspended the page was announced twice (the push and a local copy).
  if (!active) return;
  // Status must be refreshed after the native foreground mapping is set;
  // after a process restart the initial status is deliberately disabled.
  await authoritativeStatus();
}

// Read while this module loads, before boot restoration rewrites the address
// (see `landedNativePushOpen`).
let landedOpen = typeof location === "undefined" ? undefined : landedNativePushOpen(location.search);

function clearNativePushOpen(): void {
  const clean = withoutNativePushOpen(location.href);
  if (clean !== undefined) history.replaceState(history.state, "", clean);
}

/** Run after authenticated project/session restoration. The provider UUID
 * selects only an account-scoped canonical record, never a session directly. */
export async function openPendingNativePushAfterHydration(): Promise<void> {
  const notificationId = landedOpen;
  landedOpen = undefined;
  if (typeof location !== "undefined") clearNativePushOpen();
  if (!notificationId || !nativePushAvailable()) return;
  await openNativePushTarget(notificationId, {
    registered: async () => {
      let state = (await authoritativeStatus()).state;
      // The native side answers "disabled" until this page is its foreground
      // account; boot sets that, and a failure there would drop the tap.
      if (state === "disabled") {
        await reconcileNativePushForeground(true).catch(() => undefined);
        state = (await authoritativeStatus()).state;
      }
      return state === "enabled" && nativePushLocalProjectionEnabled();
    },
    record: async (id) => {
      let response: Response;
      try {
        response = await fetch(`/api/notifications/${encodeURIComponent(id)}`, json("GET"));
      } catch {
        return "unreachable"; // transient connectivity: create no trust
      }
      if (!response.ok) return response.status >= 400 && response.status < 500 ? "gone" : "unreachable";
      const record = await response.json().catch(() => undefined) as Partial<{ id: string; sessionId: string; projectId: string }> | undefined;
      return record && typeof record.id === "string" && record.id.toLowerCase() === id
        && typeof record.sessionId === "string" && typeof record.projectId === "string"
        ? { sessionId: record.sessionId }
        : "gone";
    },
    open: (sessionId) => openSession(sessionId),
    markRead: async (id) => { await request("/api/notifications/read", json("POST", { ids: [id] })); },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
