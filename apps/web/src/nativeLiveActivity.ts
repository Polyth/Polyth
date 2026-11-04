// Host wiring for the iOS Live Activity (Dynamic Island / Lock Screen): binds
// the store to the pure projection in liveActivity.ts and the native bridge.
// Installs nothing outside the iOS app build that embeds the widget extension.
import type { SessionProjection } from "@polyth/contracts";
import {
  endNativeLiveActivity,
  nativeLiveActivityAvailable,
  nativeLiveActivityStatus,
  onNativeLiveActivityOpen,
  onNativeLiveActivityPushToken,
  setNativeLiveActivityContext,
  updateNativeLiveActivity,
  type NativeLiveActivityContext,
} from "@polyth/mobile/native";
import { activeBrowserAccountId } from "./accountStorage.ts";
import { getSyncFreshness, openNativeAppPath, subscribeSyncFreshness } from "./init.ts";
import {
  LiveActivityPublisher,
  liveActivityFinal,
  liveActivitySnapshot,
  liveActivityTexts,
  liveActivityTrack,
  type LiveActivityFreshness,
  type LiveActivityTrack,
  type LiveActivityTracker,
} from "./liveActivity.ts";
import { getState, modelForAutoAccept, overlaySessionProjection, reduceSessionModel, subscribeStore } from "./store.ts";

let teardown: (() => void) | null = null;
let installing = false;
const NO_EVENTS: never[] = [];

/** The rows as the navigator presents them (an in-flight send already works,
 *  the open chat's requests come from its live window), so the activity never
 *  disagrees with the list it summarizes. */
function presentedSessions(): SessionProjection[] {
  const state = getState();
  return state.sessions.map((session) => overlaySessionProjection(session, state.pendingSends) ?? session);
}

function evaluate() {
  const state = getState();
  const activeId = state.activeSessionId;
  const sessions = presentedSessions();
  const active = activeId ? sessions.find((session) => session.id === activeId) : undefined;
  const activeModel = activeId && active
    ? modelForAutoAccept(reduceSessionModel(activeId, state.events[activeId] ?? NO_EVENTS), active)
    : null;
  const input = { sessions, activeSessionId: activeId, activeModel, events: state.events };
  return {
    snapshot: liveActivitySnapshot(input),
    track: liveActivityTrack(input),
    final: (previous: Parameters<typeof liveActivityFinal>[0]) => liveActivityFinal(previous, presentedSessions()),
  };
}

const PUSH_PATH = "/api/native-push/live-activity";

async function pushRequest<T>(method: string, body?: unknown): Promise<T> {
  const response = await fetch(PUSH_PATH, {
    method,
    credentials: "include",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

/** The server half of Live Activity push. Pushes need the activity's token
 *  registered with this server (which holds the APNs key); only then does the
 *  island's chat reach the server, and only an accepted track earns the
 *  longer trust window. Requests run one at a time, in order, over the same
 *  Polyth Link connection as the rest of the page. */
function pushTracker(onTrusted: () => void): LiveActivityTracker & { confirm(): void } {
  let confirmed = false;
  let accepted = false;
  let latest: LiveActivityTrack | null = null;
  let chain: Promise<void> = Promise.resolve();
  const run = (work: () => Promise<void>) => { chain = chain.then(work).catch(() => { accepted = false; }); };
  const send = () => run(async () => {
    const track = latest;
    if (!confirmed || !track) return;
    const result = await pushRequest<{ tracked?: boolean }>("PUT", track);
    if (latest !== track) return;
    accepted = result.tracked === true;
    onTrusted();
  });
  return {
    track(track) { latest = track; send(); },
    untrack() {
      latest = null;
      accepted = false;
      if (confirmed) run(async () => { await pushRequest("DELETE"); });
    },
    trusted: () => confirmed && accepted,
    confirm() { confirmed = true; send(); },
  };
}

/** Lets the activity take pushes when this server can send them (it holds
 *  an APNs key): each token native reports is registered, then tracked. */
async function connectPush(tracker: ReturnType<typeof pushTracker>): Promise<() => void> {
  const server = await pushRequest<{ enabled?: boolean }>("GET").catch(() => null);
  if (!server?.enabled) return () => {};
  return onNativeLiveActivityPushToken((token) => {
    void pushRequest<{ ok?: boolean }>("POST", token)
      .then((result) => { if (result.ok === true) tracker.confirm(); })
      .catch(() => undefined);
  });
}

/** Both halves of the catch-up (the open chat and the list) confirmed. */
const confirmed = (): boolean => {
  const freshness = getSyncFreshness();
  return freshness.session && freshness.sessions;
};

export async function installLiveActivity(): Promise<void> {
  if (teardown || installing || !nativeLiveActivityAvailable()) return;
  installing = true;
  const status = await nativeLiveActivityStatus().catch(() => ({ supported: false, enabled: false }));
  // Before the first update: an activity requested without a push token can
  // never take pushes. The account is the same binding input native push uses.
  const context: NativeLiveActivityContext = status.supported
    ? await setNativeLiveActivityContext({ accountId: activeBrowserAccountId(), texts: liveActivityTexts() }).catch(() => ({ push: false }))
    : { push: false };
  installing = false;
  if (!status.supported || teardown) return;
  // The socket closes as soon as the page hides, so "confirmed until" is the
  // moment the receipts stopped holding, not the last time anything changed.
  let wasConfirmed = confirmed();
  let confirmedAt: number | null = wasConfirmed ? Date.now() : null;
  const freshness = (): LiveActivityFreshness =>
    confirmed() ? { current: true, confirmedAt: Date.now() } : { current: false, confirmedAt };
  // Called only after a server reply, long after the publisher exists.
  const tracker = pushTracker(() => publisher.schedule());
  const publisher = new LiveActivityPublisher({
    bridge: { update: updateNativeLiveActivity, end: endNativeLiveActivity },
    evaluate,
    freshness,
    tracker,
    timers: { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  });
  let stopPush: () => void = () => {};
  let removed = false;
  if (context.push) void connectPush(tracker).then((stop) => { if (removed) stop(); else stopPush = stop; });
  const unsubscribe = subscribeStore(() => publisher.schedule());
  const stopFreshness = subscribeSyncFreshness(() => {
    const now = confirmed();
    if (wasConfirmed !== now) confirmedAt = Date.now();
    wasConfirmed = now;
    publisher.schedule();
  });
  // A tap names a session id. Act only on a chat this page's store knows (the
  // activity this page published, or another chat of the same server);
  // otherwise the app has simply come to the foreground.
  const stopOpen = onNativeLiveActivityOpen((sessionId) => {
    const known = publisher.currentSessionId() === sessionId
      || getState().sessions.some((session) => session.id === sessionId);
    if (known && getState().activeSessionId !== sessionId) {
      openNativeAppPath(`/?session=${encodeURIComponent(sessionId)}`);
    }
  });
  void publisher.flush();
  teardown = () => {
    removed = true;
    unsubscribe();
    stopFreshness();
    stopOpen();
    stopPush();
    publisher.dispose();
  };
}

export function uninstallLiveActivity(): void {
  teardown?.();
  teardown = null;
}
