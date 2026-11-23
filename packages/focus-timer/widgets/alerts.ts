// What happens in this tab when a segment runs out (the controller claims
// the moment, so only one tab rings): the sound, a system notification while
// Polyth is in the background, a short vibration on phones and, when the
// floating window is hidden, one host notification with the next step. The
// window's own flash and colour come from the shared state (TimerWindow.tsx).
import type { WebPackageHost } from "@polyth/web-sdk";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import type { FinishedSegment } from "../src/timerModel.ts";
import type { TimerController, TimerEffects, TimerSnapshot } from "./controller.ts";
import { playSound } from "./sound.ts";

export type SystemPermission = "granted" | "denied" | "default" | "unsupported";

type NotificationCtor = typeof Notification;

function notificationApi(): NotificationCtor | null {
  const api = (globalThis as { Notification?: NotificationCtor }).Notification;
  return typeof api === "function" ? api : null;
}

export function systemPermission(): SystemPermission {
  const api = notificationApi();
  if (!api) return "unsupported";
  return api.permission as SystemPermission;
}

export async function requestSystemPermission(): Promise<SystemPermission> {
  const api = notificationApi();
  if (!api) return "unsupported";
  if (api.permission !== "default") return api.permission as SystemPermission;
  try {
    return await api.requestPermission() as SystemPermission;
  } catch {
    return systemPermission();
  }
}

export function finishedCopy(finished: FinishedSegment, snapshot: TimerSnapshot): { title: string; body: string; next: string | null } {
  const { settings, timer } = snapshot;
  if (finished.mode === "countdown") {
    return {
      title: tr("focustimer.done.countdown"),
      body: tr("focustimer.done.countdownBody", { minutes: timer.countdownMin }),
      next: null,
    };
  }
  const running = timer.status === "running";
  if (finished.phase === "focus") {
    const minutes = timer.phase === "long" ? settings.longMin : settings.shortMin;
    return {
      title: tr("focustimer.done.focus"),
      body: tr(running ? "focustimer.done.breakStarted" : "focustimer.done.nextBreak", { minutes }),
      next: running ? null : tr("focustimer.action.startBreak"),
    };
  }
  return {
    title: tr(finished.phase === "long" ? "focustimer.done.long" : "focustimer.done.short"),
    body: tr(running ? "focustimer.done.focusStarted" : "focustimer.done.nextFocus", { minutes: settings.focusMin }),
    next: running ? null : tr("focustimer.action.startFocus"),
  };
}

const appInBackground = (): boolean =>
  typeof document !== "undefined" && (document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus()));

export function createTimerEffects(host: WebPackageHost, controller: () => TimerController | null): TimerEffects {
  let stopSound: (() => void) | null = null;
  let system: Notification | null = null;
  let toastId: string | null = null;

  const silence = () => {
    stopSound?.();
    stopSound = null;
    system?.close();
    system = null;
    if (toastId) host.notifications?.dismiss(toastId);
    toastId = null;
  };

  return {
    ring(finished, snapshot) {
      silence();
      const { settings } = snapshot;
      const copy = finishedCopy(finished, snapshot);
      if (settings.sound) stopSound = playSound(settings.soundId, settings.volume, settings.repeat);
      if (settings.flash) {
        try { (navigator as Navigator & { vibrate?: (pattern: number[]) => boolean }).vibrate?.([180, 90, 180]); } catch { /* not offered */ }
      }
      if (settings.system && appInBackground() && systemPermission() === "granted") {
        try {
          const api = notificationApi()!;
          system = new api(copy.title, { body: copy.body, tag: "polyth-focus-timer", silent: settings.sound });
          system.onclick = () => {
            try { window.focus(); } catch { /* the browser decides */ }
            controller()?.show();
            system?.close();
          };
        } catch { /* blocked or unavailable in this context */ }
      }
      // A hidden window still owes the person the news, once, in the app.
      if (!snapshot.window.open && host.notifications) {
        const handle = host.notifications.show({
          id: "focus-timer.finished",
          kind: "info",
          title: copy.title,
          body: copy.body,
          duration: 12_000,
          actions: [
            ...(copy.next ? [{ label: copy.next, primary: true, run: () => controller()?.start() }] : []),
            { label: tr("focustimer.action.show"), run: () => controller()?.show() },
          ],
          onDismiss: () => { if (toastId === handle.id) toastId = null; },
        });
        toastId = handle.id;
      }
    },
    silence,
  };
}
