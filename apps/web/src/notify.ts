// Notification router. Watches store snapshots, derives specs through
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
import { isNativeMobile } from "@polyth/mobile/runtime";
import { webPushDeliveryActive } from "./push.ts";
import { notificationCentre } from "./notificationCentre.ts";
import {
  nativePushLocalProjectionEnabled,
  requestNativeNotificationPermission,
  showNativeLocalNotification,
} from "@polyth/mobile/native";
import { COMPLETION_SOUND_URI } from "./assets/completionSound.ts";
import type { NotificationRecord } from "@polyth/contracts";
import { dismissNotification, notify as showBanner } from "./notify/store.ts";
import {
  addToThread,
  isPeopleKind,
  peopleNotificationTag,
  planPeopleAlert,
  recordChat,
  type PeopleThread,
} from "./peopleAlerts.ts";
import { forgetPersonMessageOperation, personMessageOperationId, postPersonMessage } from "./sessionPeople.ts";

export function requestNotifyPermission(): void {
  if (isNativeMobile()) {
    void requestNativeNotificationPermission().catch(() => undefined);
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

// The completion ding must never create an HTMLMediaElement. On iOS and
// Android a media element registers with the OS media session, so the lock
// screen / notification shade keeps listing Polyth as a now-playing "player"
// long after a short sound has finished. Web Audio has no such session, so the
// embedded clip is decoded once and played through a buffer source instead.
const COMPLETION_SOUND_BASE64 = COMPLETION_SOUND_URI.slice(COMPLETION_SOUND_URI.indexOf(",") + 1);

let completionContext: AudioContext | null = null;
let completionBuffer: AudioBuffer | null = null;
let completionDecode: Promise<AudioBuffer | null> | null = null;
let completionGestureBound = false;

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function completionAudioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  if (!completionContext || completionContext.state === "closed") {
    try {
      completionContext = new Ctor({ latencyHint: "interactive" });
    } catch {
      return null;
    }
  }
  return completionContext;
}

function decodeCompletion(context: AudioContext): Promise<AudioBuffer | null> {
  completionDecode ??= (async () => {
    try {
      const binary = atob(COMPLETION_SOUND_BASE64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      completionBuffer = await context.decodeAudioData(bytes.buffer);
      return completionBuffer;
    } catch {
      return null;
    }
  })();
  return completionDecode;
}

/** Mobile WebKit only lets an AudioContext leave "suspended" inside a user
 *  gesture, and a completion fires later from a store update. Prime the shared
 *  context (and decode the clip) on the first real interaction so the ding can
 *  play from a timer without ever touching a media element. iOS suspends (or
 *  "interrupts") the context again after the app is backgrounded or a call
 *  takes the audio route, so every later gesture re-primes a context that is
 *  not running instead of only the first one. */
function primeCompletionSound(): void {
  const context = completionAudioContext();
  if (!context) return;
  if (context.state !== "running") void context.resume().catch(() => {});
  void decodeCompletion(context);
}

function primeCompletionSoundOnGesture(): void {
  if (completionGestureBound || typeof document === "undefined") return;
  completionGestureBound = true;
  const prime = () => {
    if (completionContext?.state === "running" && completionBuffer) return;
    primeCompletionSound();
  };
  document.addEventListener("pointerdown", prime, { capture: true, passive: true });
  document.addEventListener("keydown", prime, true);
}

export function playCompletionSound(): void {
  const context = completionAudioContext();
  if (!context) {
    beep();
    return;
  }
  void (async () => {
    try {
      if (context.state !== "running") await context.resume();
      // Autoplay-blocked contexts stay suspended; starting now would queue a
      // stale ding that fires on some later gesture.
      if (context.state !== "running") return;
      const buffer = completionBuffer ?? await decodeCompletion(context);
      if (!buffer) {
        beep();
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        try { source.disconnect(); } catch { /* already detached */ }
      };
      source.start();
    } catch {
      beep();
    }
  })();
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

/** Present one derived notification on the OS (native mobile or browser).
 *  Exported for tests; production entry is `installNotify`. */
export function showNative(source: NotificationSpec): void {
  // The server's centre record carries the concrete content (reply excerpt,
  // command, question). The record may land before or after this local
  // template notification, and the local spec's key uses the client's status
  // vocabulary (`finished`/`waiting`) while the server keys on
  // `idle`/`failed`, so both sides are aligned on the normalised key.
  const key = transitionKey(source.key);
  // The centre keeps repeated transitions of one key: only a row stamped no
  // earlier than this transition (`since`) is its record, so an earlier
  // turn's row never supplies the text.
  const recorded = transitionRecord(key, source.since);
  const spec = recorded?.body ? { ...source, body: recorded.body } : source;
  const replace = presentNative(spec, key);
  // A template notification was shown without the record: if the matching
  // record arrives over the WS inside the short window, re-present the same
  // notification (same tag/id, no second sound) with the record's text.
  if (replace && !recorded?.body) awaitCentreRecord(key, source.since, replace);
}

/** The newest centre row for `key` stamped at or after `since`. */
function transitionRecord(key: string, since: number | undefined) {
  return notificationCentre.getState().items.findLast((item) =>
    item.key === key && (since === undefined || item.ts >= since));
}

/** Local template specs use the client's session status; the server's
 *  transition keys are `…:turn:idle|failed` / `…:subagent:idle|failed`.
 *  Normalising the suffix aligns the two where the client can know it. */
export function transitionKey(key: string): string {
  return key.replace(/:(turn|subagent):(?:finished|waiting)$/, ":$1:idle");
}

/** Short window in which a centre record may still arrive (WS latency) and
 *  replace an already-shown template notification. */
const RECORD_REPLACE_WINDOW_MS = 10_000;

/** Browser notifications this page created, by tag: the service worker's
 *  list does not include them, and reading a chat closes its own. */
const pageNotifications = new Map<string, Notification>();

/** Show the OS notification for `spec` and return a function that re-presents
 *  the SAME notification (same tag/id, no second sound) with richer text — or
 *  null when this context deliberately shows nothing. Called at most once.
 *  `people` keeps one notification per chat (`key` is the chat's tag) that
 *  alerts again for every new message, titled by its sender, not "Polyth". */
function presentNative(spec: NotificationSpec, key: string, people = false): ((body: string) => void) | null {
  if (isNativeMobile()) {
    // Remote push owns the OS projection only after its native controller has
    // confirmed the active trusted connection/account mapping. Browser and
    // local-native fallback continue unchanged for every other context.
    if (nativePushLocalProjectionEnabled()) return null;
    let id = 17;
    for (const character of key) id = (id * 31 + character.charCodeAt(0)) & 0x7fffffff;
    const notificationId = Math.max(1, id);
    const show = (body: string) => void showNativeLocalNotification({
      id: notificationId,
      title: people ? spec.title : `Polyth — ${spec.title}`,
      body,
      extra: { sessionId: spec.sessionId },
    }).catch(() => undefined);
    show(spec.body);
    // Re-scheduling the same notification id replaces the pending local one.
    return show;
  }
  // A hidden page with a server-confirmed Web Push subscription is already
  // covered by the service worker. Keep the local Notification fallback for
  // visible/background-session alerts and for failed/unavailable Web Push.
  if (typeof document !== "undefined" && document.hidden && webPushDeliveryActive()) return null;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const tag = people ? key : `polyth-${key}`;
  const show = (body: string, quiet: boolean) => {
    const n = new Notification(people ? spec.title : `Polyth — ${spec.title}`, {
      body,
      tag,
      // Replacing the same tag with `silent` present the record's text without
      // a second sound. A chat's next message replaces its notification and
      // must alert again (`renotify`; the installed DOM lib no longer declares it).
      ...(quiet ? { silent: true } : {}),
      ...(people && !quiet ? { renotify: true } as NotificationOptions : {}),
    });
    pageNotifications.set(tag, n);
    n.onclose = () => { if (pageNotifications.get(tag) === n) pageNotifications.delete(tag); };
    n.onclick = () => {
      // Activate the owning project+session (openSession switches atomically);
      // an archived/deleted session fails quietly — the app is focused anyway.
      window.focus();
      void openSession(spec.sessionId).catch(() => undefined);
      n.close();
    };
  };
  show(spec.body, false);
  return (body) => show(body, true);
}

/** Wait for the centre record with `key` (already-arrived rows win
 *  immediately) and re-present the notification with its text exactly once
 *  inside the bounded window. */
function awaitCentreRecord(key: string, since: number | undefined, replace: (body: string) => void): void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off: () => void = () => {};
  const finish = (): boolean => {
    if (done) return false;
    done = true;
    off();
    if (timer !== undefined) clearTimeout(timer);
    return true;
  };
  const apply = (): void => {
    const body = transitionRecord(key, since)?.body;
    if (body && finish()) replace(body);
  };
  apply(); // the record may have landed between the first lookup and here
  if (done) return;
  off = notificationCentre.subscribe(apply);
  timer = setTimeout(finish, RECORD_REPLACE_WINDOW_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** Records already acted on: a WS replay or REST/WS race never alerts twice. */
const peopleHandled = new Set<string>();
/** Rows this page already asked to mark read: a failed request is not retried
 *  on every store change. */
const peopleMarked = new Set<string>();

const pageVisible = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > 500) set.delete(set.values().next().value!);
}

/** A person's message or mention arrived live (WS `notification/added`, after
 *  the inbox took the row). Routed by `planPeopleAlert`. */
export function alertPersonMessage(record: NotificationRecord): void {
  if (!isPeopleKind(record.kind) || peopleHandled.has(record.id)) return;
  remember(peopleHandled, record.id);
  const ui = getUiSettings();
  const plan = planPeopleAlert(record, {
    activeSessionId: getState().activeSessionId,
    visible: pageVisible(),
    kinds: new Set(ui.notifyKinds),
    osAlerts: ui.notifyOnComplete,
    onlyWhenHidden: ui.notifyOnlyWhenHidden,
    sound: ui.notifySound,
  });
  if (!plan) return;
  if (plan.seen) {
    if (!record.read) {
      remember(peopleMarked, record.id);
      void notificationCentre.markRead([record.id]).catch(() => undefined);
    }
    return;
  }
  if (plan.banner) showPeopleCard(record);
  if (plan.sound) playCompletionSound();
  if (plan.os) {
    const tag = peopleNotificationTag(record.sessionId);
    presentNative({ key: record.key, kind: record.kind, sessionId: record.sessionId, title: record.title, body: record.body }, tag, true);
  }
}

/** Each chat's card while it is on screen (cleared when it leaves). */
const peopleThreads = new Map<string, PeopleThread>();

/** One messenger card per chat: a burst updates it in place, brings it
 *  forward and shows its newest lines, each voice in its colour. */
function showPeopleCard(record: NotificationRecord): void {
  const sessionId = record.sessionId;
  const thread = addToThread(peopleThreads.get(sessionId), record);
  peopleThreads.set(sessionId, thread);
  showBanner({
    id: `people:${sessionId}`,
    kind: thread.mention ? "mention" : "message",
    // What a screen reader hears: "Ann · Weekend — hike on Saturday?".
    title: record.title,
    body: record.body,
    conversation: {
      sessionId,
      chat: recordChat(record),
      lines: thread.lines,
      count: thread.count,
      mention: thread.mention,
      open: () => { void openSession(sessionId).catch(() => undefined); },
      reply: (text) => replyFromCard(sessionId, text),
    },
    onDismiss: () => { peopleThreads.delete(sessionId); },
  });
}

/** A reply typed on a card: an ordinary person message, posted as the reader
 *  (idempotent on retry). Answering means the chat was read. */
async function replyFromCard(sessionId: string, text: string): Promise<void> {
  const key = `card-reply\u0000${sessionId}\u0000${text}`;
  await postPersonMessage(sessionId, { text, clientOperationId: personMessageOperationId(key) });
  forgetPersonMessageOperation(key);
  markPeopleRead(sessionId);
}

/** Marks the chat's unread people rows read and closes its OS notification. */
function markPeopleRead(sessionId: string): void {
  const unread = notificationCentre.getState().items
    .filter((item) => !item.read && item.sessionId === sessionId && isPeopleKind(item.kind) && !peopleMarked.has(item.id))
    .map((item) => item.id);
  if (unread.length > 0) {
    for (const id of unread) remember(peopleMarked, id);
    void notificationCentre.markRead(unread).catch(() => undefined);
  }
  closeOsPeopleNotification(sessionId);
}

function closeOsPeopleNotification(sessionId: string): void {
  const tag = peopleNotificationTag(sessionId);
  pageNotifications.get(tag)?.close();
  if (typeof navigator !== "undefined" && navigator.serviceWorker?.getRegistration) {
    void navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.getNotifications({ tag }))
      .then((shown) => { for (const notification of shown ?? []) notification.close(); })
      .catch(() => undefined);
  }
}

/** Reading a chat clears what its people raised: the banner, the unread inbox
 *  rows and the OS notification (page-made and service-worker-made). */
function clearPeopleAlerts(sessionId: string): void {
  dismissNotification(`people:${sessionId}`);
  markPeopleRead(sessionId);
}

function installPeopleAlerts(): void {
  let cleared: string | null = null;
  const check = () => {
    const active = pageVisible() ? getState().activeSessionId : null;
    const hasUnread = active !== null && notificationCentre.getState().items
      .some((item) => !item.read && item.sessionId === active && isPeopleKind(item.kind) && !peopleMarked.has(item.id));
    if (active === cleared && !hasUnread) return;
    cleared = active;
    if (active) clearPeopleAlerts(active);
  };
  subscribeStore(check);
  notificationCentre.subscribe(check);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", check);
  check();
}

export function installNotify(): void {
  primeCompletionSoundOnGesture();
  installPeopleAlerts();
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
      ...(p.backgroundWork ? { backgroundWork: p.backgroundWork } : {}),
      updatedAt: p.updatedAt,
    }));
    const specs = diffNotifications(prev, snapshots, {
      kinds: new Set<NotifyKind>(ui.notifyKinds),
      template: ui.notifyTemplate,
      projectNames: new Map(s.projectRegistry.projects.map((p) => [p.id, p.name])),
    });
    prev.clear();
    for (const snap of snapshots) prev.set(snap.id, snap);

    for (const spec of specs) {
      if (emitted.has(spec.key)) continue; // duplicate replay
      emitted.add(spec.key);
      if (emitted.size > 500) emitted.delete(emitted.values().next().value!);

      if (ui.notifySound && (spec.kind === "completed" || spec.kind === "failed")) playCompletionSound();
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
