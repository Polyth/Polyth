// Host wiring for the iOS Live Activity (Dynamic Island / Lock Screen): binds
// the store to the pure projection in liveActivity.ts and the native bridge.
// Installs nothing outside the iOS app build that embeds the widget extension.
import {
  endNativeLiveActivity,
  nativeLiveActivityAvailable,
  nativeLiveActivityStatus,
  onNativeLiveActivityOpen,
  updateNativeLiveActivity,
} from "@polyth/mobile/native";
import { openNativeAppPath } from "./init.ts";
import { LiveActivityPublisher, liveActivityFinal, liveActivitySnapshot } from "./liveActivity.ts";
import { getState, modelForAutoAccept, reduceSessionModel, subscribeStore } from "./store.ts";

let teardown: (() => void) | null = null;
let installing = false;
const NO_EVENTS: never[] = [];

function evaluate() {
  const state = getState();
  const activeId = state.activeSessionId;
  const active = activeId ? state.sessions.find((session) => session.id === activeId) : undefined;
  const activeModel = activeId && active
    ? modelForAutoAccept(reduceSessionModel(activeId, state.events[activeId] ?? NO_EVENTS), active)
    : null;
  return {
    snapshot: liveActivitySnapshot({
      sessions: state.sessions,
      activeSessionId: activeId,
      activeModel,
      events: state.events,
    }),
    final: (previous: Parameters<typeof liveActivityFinal>[0]) => liveActivityFinal(previous, getState().sessions),
  };
}

export async function installLiveActivity(): Promise<void> {
  if (teardown || installing || !nativeLiveActivityAvailable()) return;
  installing = true;
  const status = await nativeLiveActivityStatus().catch(() => ({ supported: false, enabled: false }));
  installing = false;
  if (!status.supported || teardown) return;
  const publisher = new LiveActivityPublisher({
    bridge: { update: updateNativeLiveActivity, end: endNativeLiveActivity },
    evaluate,
    timers: { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  });
  const unsubscribe = subscribeStore(() => publisher.schedule());
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
    stopOpen();
    publisher.dispose();
  };
}

export function uninstallLiveActivity(): void {
  teardown?.();
  teardown = null;
}
