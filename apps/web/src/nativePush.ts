import { activeBrowserAccountId } from "./accountStorage.ts";
import { hydrateClientRecord, writeClientPreference } from "./clientPersistence.ts";
import { focusSession } from "./init.ts";
import { clientAccountPersistenceScope } from "./reliabilityContext.ts";
import {
  NATIVE_PUSH_OPEN_EVENT,
  NativePushController,
  claimNativePushOpen,
  disableNativePush,
  enableNativePush,
  nativePushAvailable,
  nativePushLocalProjectionEnabled,
  refreshNativePushStatus,
  setNativePushAuthoritativeProjection,
  setNativePushForeground,
  settleNativePushOpen,
  type NativePushStatus,
} from "@polyth/mobile/native";
import {
  landedNativePushOpen,
  nativePushTaps,
  offerNativePushBootTarget,
  openNativePushTarget,
  withoutNativePushOpen,
} from "./nativePushOpen.ts";

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

type InboxRecord = { sessionId: string } | "gone" | "unreachable";

/** The signed-in account's own inbox row for a tapped notification. */
async function inboxRecord(id: string): Promise<InboxRecord> {
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
}

async function registrationConfirmed(): Promise<boolean> {
  // Confirmed earlier in this page's life (at boot, or on the last return to
  // the foreground): a tap for the page on screen needs no second round trip.
  if (nativePushLocalProjectionEnabled()) return true;
  let state = (await authoritativeStatus()).state;
  // The native side answers "disabled" until this page is its foreground
  // account; boot sets that, and a failure there would drop the tap.
  if (state === "disabled") {
    await reconcileNativePushForeground(true).catch(() => undefined);
    state = (await authoritativeStatus()).state;
  }
  return state === "enabled" && nativePushLocalProjectionEnabled();
}

/** The first inbox read of a tap, started before boot restoration so the
 *  launch lands on the tapped chat (`startNativePushOpen`). */
let earlyRecord: { id: string; record: Promise<InboxRecord> } | undefined;

const taps = nativePushTaps({
  claim: async () => nativePushAvailable()
    ? await claimNativePushOpen({ accountId: activeBrowserAccountId() }).catch(() => undefined)
    : undefined,
  // The provider UUID selects only an account-scoped canonical record, never a session directly.
  open: async (notificationId) => {
    let early = earlyRecord?.id === notificationId ? earlyRecord.record : undefined;
    earlyRecord = undefined;
    return await openNativePushTarget(notificationId, {
      registered: registrationConfirmed,
      record: (id) => {
        const read = early ?? inboxRecord(id);
        early = undefined;
        return read;
      },
      // The chat already on screen is not opened a second time.
      open: (sessionId) => focusSession(sessionId),
      markRead: async (id) => { await request("/api/notifications/read", json("POST", { ids: [id] })); },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  },
  settle: (notificationId) => settleNativePushOpen(notificationId),
});

/** Called once the account is known, before the launch restores anything.
 *
 *  A page that is loaded again while a tap for it is pending (its process was
 *  ended in the background, or the connection was rebuilt) finds that tap
 *  here. It is claimed before the other launch reads: the native side waits
 *  only a few seconds for a claim before it sends the tap through the hub. */
export async function claimNativePushOpenAtBoot(): Promise<void> {
  if (landedOpen || !nativePushAvailable()) return;
  landedOpen = await claimNativePushOpen({ accountId: activeBrowserAccountId() }).catch(() => undefined);
}

/** Called right before boot restoration. With this device's registration
 *  already confirmed, the tap's inbox row is read while the launch loads, and
 *  the launch lands on that chat instead of the remembered one. */
export function startNativePushOpen(): void {
  const id = landedOpen;
  if (!id || !nativePushAvailable() || !nativePushLocalProjectionEnabled()) return;
  const record = inboxRecord(id);
  earlyRecord = { id, record };
  offerNativePushBootTarget(record.then((row) => typeof row === "object" ? row.sessionId : undefined));
}

let listening = false;

/** Run after authenticated project/session restoration. From here on a tap
 *  for this page's own server reaches it where it is: the native app raises
 *  `NATIVE_PUSH_OPEN_EVENT` instead of replacing the page with the hub. */
export async function openPendingNativePushAfterHydration(): Promise<void> {
  const notificationId = landedOpen;
  landedOpen = undefined;
  if (typeof location !== "undefined") clearNativePushOpen();
  if (!nativePushAvailable()) return;
  if (!listening) {
    listening = true;
    window.addEventListener(NATIVE_PUSH_OPEN_EVENT, () => { void taps.take(); });
  }
  if (notificationId) await taps.open(notificationId);
  // A tap that arrived while this page was loading raised its event before
  // anything listened.
  await taps.take();
}
