// Notification router (WP15). Watches store snapshots, derives specs through
// the pure diffNotifications, dedupes across replays, and routes native
// notification clicks back to the owning project/session.
import { getState, subscribeStore } from "./store.ts";
import { openSession } from "./init.ts";
import { getUiSettings } from "./uiPrefs.ts";
import {
  diffNotifications,
  type NotificationSpec,
  type NotifyKind,
  type SessionSnapshot,
} from "./notifications.ts";

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

function showNative(spec: NotificationSpec): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const n = new Notification(`Polyth — ${spec.title}`, {
    body: spec.body,
    tag: `polyth-${spec.key}`,
  });
  n.onclick = () => {
    // Activate the owning project+session (openSession switches atomically);
    // an archived/deleted session fails quietly — the app is focused anyway.
    window.focus();
    void openSession(spec.sessionId).catch(() => {});
    n.close();
  };
}

export function installNotify(): void {
  const prev = new Map<string, SessionSnapshot>();
  const emitted = new Set<string>();

  subscribeStore(() => {
    const s = getState();
    const ui = getUiSettings();
    const snapshots: SessionSnapshot[] = s.sessions.map((p) => ({
      id: p.id,
      projectId: p.projectId,
      title: p.title,
      status: p.status,
      ...(p.parentId ? { parentId: p.parentId } : {}),
      ...(p.attention ? { attention: { questions: p.attention.questions, permissions: p.attention.permissions } } : {}),
    }));
    const specs = diffNotifications(prev, snapshots, {
      kinds: new Set<NotifyKind>(ui.notifyKinds),
      template: ui.notifyTemplate,
      projectNames: new Map(s.projects.map((p) => [p.id, p.name])),
    });
    prev.clear();
    for (const snap of snapshots) prev.set(snap.id, snap);

    for (const spec of specs) {
      if (emitted.has(spec.key)) continue; // duplicate replay
      emitted.add(spec.key);
      if (emitted.size > 500) emitted.delete(emitted.values().next().value!);

      if (ui.notifySound && (spec.kind === "completed" || spec.kind === "failed")) beep();
      if (!ui.notifyOnComplete) continue;
      // Foreground events on the active session stay quiet by default; with
      // onlyWhenHidden off, other sessions may still notify in the foreground.
      const hidden = typeof document !== "undefined" && document.hidden;
      if (ui.notifyOnlyWhenHidden && !hidden) continue;
      if (!hidden && spec.sessionId === s.activeSessionId) continue;
      showNative(spec);
    }
  });
}
