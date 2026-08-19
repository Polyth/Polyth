// Turn-completion notifications (Settings > Notifications). Watches session
// status transitions in the store; fires a browser notification when a turn
// finishes while the tab is hidden, and/or a short beep.
import { getState, subscribeStore } from "./store.ts";
import { getUiSettings } from "./uiPrefs.ts";

const DONE = new Set(["idle", "finished", "failed", "waiting"]);

export function requestNotifyPermission(): void {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.04;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => void ctx.close();
  } catch {
    // audio unavailable
  }
}

export function installNotify(): void {
  const prev = new Map<string, string>();
  subscribeStore(() => {
    const s = getState();
    for (const session of s.sessions) {
      const before = prev.get(session.id);
      prev.set(session.id, session.status);
      if (before !== "working" || !DONE.has(session.status)) continue;
      const ui = getUiSettings();
      if (ui.notifySound) beep();
      if (
        ui.notifyOnComplete &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        document.hidden
      ) {
        const title = session.title || "Session";
        new Notification("Polyth — turn finished", {
          body: session.status === "failed" ? `${title} failed` : `${title} is ready`,
          tag: `polyth-${session.id}`,
        });
      }
    }
  });
}
