// Host wiring for the iOS Live Activity (Dynamic Island / Lock Screen): binds
// the store to the pure projection in liveActivity.ts and the native bridge.
// Installs nothing outside the iOS app build that embeds the widget extension.
import type { SessionProjection } from "@polyth/contracts";
import {
  endNativeLiveActivity,
  nativeLiveActivityAvailable,
  nativeLiveActivityStatus,
  onNativeLiveActivityOpen,
  updateNativeLiveActivity,
} from "@polyth/mobile/native";
import { getSyncFreshness, openNativeAppPath, subscribeSyncFreshness } from "./init.ts";
import { LiveActivityPublisher, liveActivityFinal, liveActivitySnapshot, type LiveActivityFreshness } from "./liveActivity.ts";
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
  return {
    snapshot: liveActivitySnapshot({
      sessions,
      activeSessionId: activeId,
      activeModel,
      events: state.events,
    }),
    final: (previous: Parameters<typeof liveActivityFinal>[0]) => liveActivityFinal(previous, presentedSessions()),
  };
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
  installing = false;
  if (!status.supported || teardown) return;
  // The socket closes as soon as the page hides, so "confirmed until" is the
  // moment the receipts stopped holding, not the last time anything changed.
  let wasConfirmed = confirmed();
  let confirmedAt: number | null = wasConfirmed ? Date.now() : null;
  const freshness = (): LiveActivityFreshness =>
    confirmed() ? { current: true, confirmedAt: Date.now() } : { current: false, confirmedAt };
  const publisher = new LiveActivityPublisher({
    bridge: { update: updateNativeLiveActivity, end: endNativeLiveActivity },
    evaluate,
    freshness,
    timers: { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  });
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
    unsubscribe();
    stopFreshness();
    stopOpen();
    publisher.dispose();
  };
}

export function uninstallLiveActivity(): void {
  teardown?.();
  teardown = null;
}
