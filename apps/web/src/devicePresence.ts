// Device presence: tells the server whether the person is using this page, and
// learns whether they are working on another device right now. While they
// are, this device keeps quiet: no sound, no OS notification, no Live Activity
// (the server likewise skips its push). With nobody active every device is
// alerted as before. A page its person left for another tab or window still
// counts for a while: they are most likely at the same device, and what they
// do not read there is sent on to their other devices. Contract:
// docs/mobile/platform-behavior.md
// "Only the device in use"; server half: packages/server/src/devicePresence.ts.

/** No touch for this long and the page no longer counts as in use. */
export const PRESENCE_IDLE_MS = 5 * 60_000;
/** A hidden page (another tab or window in front) counts as in use this long
 *  after its person left it. It cannot see touches, so the server treats the
 *  claim as a guess and sends an unread alert on to the other devices. */
export const PRESENCE_HIDDEN_MS = 15 * 60_000;
/** While in use, the page re-reports this often (the server's lease is 150 s). */
export const PRESENCE_HEARTBEAT_MS = 60_000;
/** Touches re-report at most this often, so the newest device wins quickly. */
const PRESENCE_TOUCH_GAP_MS = 15_000;
const CLIENT_ID_KEY = "polyth.presence.client-id";
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface PresenceReport {
  clientId: string;
  active: boolean;
  idleMs: number;
  /** The page is not on screen: `active` rests on its last touch alone. */
  hidden: boolean;
}

/** The part of SyncClient presence needs. */
export interface PresenceTransport {
  sendPresence(report: PresenceReport): boolean;
  onOpen(cb: () => void): () => void;
  onEvent(cb: (msg: { type: string; activeElsewhere?: unknown }) => void): () => void;
}

export interface PresenceEnvironment {
  now(): number;
  visible(): boolean;
  /** Registers the page's touch and visibility listeners; returns the remover. */
  listen(onTouch: () => void, onVisibility: () => void): () => void;
  every(ms: number, callback: () => void): () => void;
}

let elsewhere = false;
const listeners = new Set<() => void>();

/** The person is working on another of their devices right now. */
export function activeElsewhere(): boolean {
  return elsewhere;
}

export function subscribeActiveElsewhere(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function setActiveElsewhere(value: boolean): void {
  if (elsewhere === value) return;
  elsewhere = value;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* one listener cannot stop the others */ }
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** This install's id: names a loopback page (the desktop app, a browser on the
 *  host) whose connection carries no device identity of its own. */
export function presenceClientId(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string {
  try {
    const stored = storage?.getItem(CLIENT_ID_KEY);
    if (stored && CLIENT_ID.test(stored)) return stored;
  } catch { /* storage unavailable: a fresh id per page load */ }
  const id = randomId();
  try { storage?.setItem(CLIENT_ID_KEY, id); } catch { /* kept in memory only */ }
  return id;
}

function browserEnvironment(): PresenceEnvironment {
  return {
    now: () => Date.now(),
    visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    listen(onTouch, onVisibility) {
      const options = { capture: true, passive: true } as const;
      const touches = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
      for (const type of touches) window.addEventListener(type, onTouch, options);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        for (const type of touches) window.removeEventListener(type, onTouch, options);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    every(ms, callback) {
      const handle = setInterval(callback, ms);
      return () => clearInterval(handle);
    },
  };
}

/** Reports this page's presence over the sync socket and applies the
 *  server's answer. Returns the uninstaller. */
export function installDevicePresence(
  transport: PresenceTransport,
  env: PresenceEnvironment = browserEnvironment(),
  clientId: string = presenceClientId(),
): () => void {
  // Opening the app or the page is a touch.
  let touchedAt = env.now();
  let sentActive: boolean | undefined;
  let sentAt = Number.NEGATIVE_INFINITY;
  let shown = env.visible();
  // Whether the page was in use when its person left it: only then does it
  // keep counting while hidden. One that had gone idle first stays idle.
  let leftInUse = true;
  const inUse = () => env.visible()
    ? env.now() - touchedAt < PRESENCE_IDLE_MS
    : leftInUse && env.now() - touchedAt < PRESENCE_HIDDEN_MS;
  const report = (force: boolean) => {
    const active = inUse();
    const now = env.now();
    if (!force && active === sentActive && (!active || now - sentAt < PRESENCE_TOUCH_GAP_MS)) return;
    if (!transport.sendPresence({ clientId, active, idleMs: Math.max(0, now - touchedAt), hidden: !env.visible() })) return;
    sentActive = active;
    sentAt = now;
  };
  const stopListening = env.listen(
    () => { touchedAt = env.now(); report(false); },
    () => {
      const visible = env.visible();
      // Showing the page is a touch. So is leaving a page that was in use:
      // its person just switched away from it. A page that had already gone
      // idle (a screen locking by itself) gains nothing by being hidden.
      if (visible) touchedAt = env.now();
      else if (shown) {
        leftInUse = env.now() - touchedAt < PRESENCE_IDLE_MS;
        if (leftInUse) touchedAt = env.now();
      }
      shown = visible;
      report(true);
    },
  );
  // Keeps the lease while in use and notices going idle.
  const stopTimer = env.every(PRESENCE_HEARTBEAT_MS, () => {
    if (inUse() || sentActive) report(true);
  });
  const stopOpen = transport.onOpen(() => {
    sentActive = undefined;
    report(true);
  });
  const stopEvents = transport.onEvent((msg) => {
    if (msg.type === "presence/state" && typeof msg.activeElsewhere === "boolean") setActiveElsewhere(msg.activeElsewhere);
  });
  report(true);
  return () => {
    stopListening();
    stopTimer();
    stopOpen();
    stopEvents();
    setActiveElsewhere(false);
  };
}
