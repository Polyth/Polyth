// One press on Send, from the moment it lands to the one thing it does.
//
// Send is an ordinary button to the platform: nothing here cancels an event,
// so the browser keeps every native path it has (pointer events, touch
// events, the click it synthesises for a tap). The press only listens, on the
// window in the capture phase, where no other listener can hide an event from
// it, and it takes the first sign that the press ended from whichever path
// brought it. Every press ends in exactly one outcome:
//
//   send   released before the hold length, still on Send;
//   draft  held for the hold length (`sendHold.ts`);
//   none   abandoned: the finger slid off Send, another press began, or the
//          page went to the background.
//
// What this replaces. Touch Send used to act on its own `pointerup` alone,
// with the click swallowed (and later cancelled outright), and a held press
// was judged only when that release arrived. On phones the release of a press
// beside the end of the draft did not always reach the page: the press then
// did nothing at all, neither a send nor a kept draft, and each repair added
// another flag beside the others. The rules that make a lost event harmless:
//
// - Any end is an end. `pointerup`, `touchend` and the tap's `click` each
//   settle a press that is still open; the ones that follow belong to a press
//   already spent and do nothing (`SEND_TRAILING_CLICK_MS`).
// - A click with no press behind it sends. That is the keyboard and assistive
//   path, and it is also the whole of a tap whose other events never came.
// - A hold does not wait for the finger. Once the hold length has passed the
//   control shows its cue (`onCue`), and the draft is kept at the release or
//   `SEND_HOLD_GRACE_MS` later, whichever comes first. A release stamped
//   before the hold length still sends, however late a busy page delivered it.
// - A touch the system takes away (`pointercancel`, `touchcancel`) is a press
//   whose lift will not be heard, not a press that did nothing: it stays open,
//   so its click still sends and its hold is still kept.
// - A new press anywhere ends the one before it, and only a press that took
//   effect swallows the click that follows it.
//
// A press is timed between the input's own stamps (`inputTime`), never by when
// the handlers happened to run. The ring is the press's picture, drawn by CSS
// from one attribute on the control, so pressing Send renders nothing in React:
// `data-send-hold="arming"` winds it over the hold length from the press's
// real age (`--send-hold-age`), `"full"` is the reached hold, `"release"`
// fades it where it stood.
//
// The last presses are kept as a trace (`sendPressTrace`): event names and
// millisecond offsets only, never the message. It is what a report from a
// real phone can carry when a press still goes wrong, and a person copies it
// from Settings > Chat > Send diagnostics (`sendPressReport`).

import { inputTime, sendPressOutcome } from "../sendHold.ts";
import { releaseSends } from "./sendRelease.ts";

/** How long a released ring fades before its attribute is dropped: the
 *  slowest theme's `--motion-surface`, plus a frame. */
export const SEND_HOLD_RELEASE_MS = 320;
/** After the cue, how long an unreleased press waits before its draft is kept
 *  anyway. Long enough for a lift queued behind a busy page to be delivered
 *  first; short enough that the check and the kept draft read as one moment. */
export const SEND_HOLD_GRACE_MS = 250;
/** How long after a press ended its own click may still arrive. */
export const SEND_TRAILING_CLICK_MS = 700;
/** A press that landed this close to Send but on something else is traced. */
const NEAR_MISS_PX = 48;
const TRACE_PRESSES = 24;
const TRACE_EVENTS = 16;
const TRACE_STORAGE_KEY = "polyth.sendPress.trace";

export type SendPressOutcome = "send" | "draft" | "none";

export interface SendPressHandlers {
  /** The hold length for a press that begins now, or 0 when this press cannot
   *  be held (the gesture is off, or there is nothing to keep). */
  holdMs(): number;
  /** Released before the hold length: send. */
  onSend(): void;
  /** Held for the hold length: keep the message as a draft. */
  onDraft(): void;
  /** The hold length passed with the press still open. */
  onCue?(): void;
  /** A cue that is taken back: the press sends or was abandoned after all. */
  onCueDropped?(): void;
}

export interface SendPressOptions {
  /** The clock input stamps are read against (tests). */
  now?: () => number;
}

interface Press {
  pointerId: number | null;
  touchId: number | null;
  /** The press's start on the input clock, per event family: a release is
   *  measured against the stamp of its own family where there is one. */
  downAt: { pointer: number | null; touch: number | null };
  /** When the first handler ran, on the page's clock. */
  seenAt: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  holdMs: number;
  phase: "down" | "cued" | "spent";
  /** What a spent press did. */
  result: SendPressOutcome;
  /** When the end of a spent press was heard; null while it has not been. */
  endedAt: number | null;
  timer: number | null;
  yields: number;
  trace: TraceEntry;
}

interface TraceEntry {
  /** Wall clock of the press, ms since the epoch. */
  at: number;
  kind: string;
  hold: number;
  focus: string;
  events: string[];
  outcome: string;
}

const trace: TraceEntry[] = [];

function remember(entry: TraceEntry): void {
  trace.push(entry);
  if (trace.length > TRACE_PRESSES) trace.splice(0, trace.length - TRACE_PRESSES);
}

function persistTrace(): void {
  try {
    globalThis.localStorage?.setItem(TRACE_STORAGE_KEY, sendPressTrace());
  } catch {
    // Storage is a convenience for a later report; a full or blocked one is not an error.
  }
}

function traceLine(entry: TraceEntry): string {
  const time = new Date(entry.at).toISOString().slice(5, 23);
  const hold = entry.hold > 0 ? ` hold=${entry.hold}` : "";
  const focus = entry.focus ? ` focus=${entry.focus}` : "";
  return `${time} ${entry.kind}${hold}${focus} ${entry.events.join(" ")} > ${entry.outcome}`;
}

/** What the page that ran before this one recorded: the app is often reopened
 *  between a press that failed and the moment its trace is asked for. */
let carried: string[] | null = null;
function carriedLines(): string[] {
  if (carried === null) {
    try {
      carried = (globalThis.localStorage?.getItem(TRACE_STORAGE_KEY) ?? "").split("\n").filter((line) => line !== "");
    } catch {
      carried = [];
    }
  }
  return carried;
}

/** The last presses on Send, one line each, oldest first: what landed, which
 *  events arrived at which millisecond, and what the press did. No text of the
 *  message, no coordinates beyond a near miss's offset from Send. */
export function sendPressTrace(): string {
  return [...carriedLines(), ...trace.map(traceLine)].slice(-TRACE_PRESSES).join("\n");
}

declare const __POLYTH_WEB_BUILD_ID__: string;

/** The trace as a person hands it over (Settings > Chat > Send diagnostics):
 *  with the build that produced it, so a report from a device that does not
 *  run the current press yet is recognised at once, and the browser it ran in. */
export function sendPressReport(now: Date = new Date()): string {
  const lines = ["Polyth Send diagnostics", `Time: ${now.toISOString()}`];
  if (typeof __POLYTH_WEB_BUILD_ID__ === "string" && __POLYTH_WEB_BUILD_ID__) lines.push(`Web build: ${__POLYTH_WEB_BUILD_ID__}`);
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.userAgent) lines.push(`Browser: ${nav.userAgent}`);
  if (typeof nav?.maxTouchPoints === "number") lines.push(`Touch points: ${nav.maxTouchPoints}`);
  const view = globalThis as { innerWidth?: number; innerHeight?: number };
  if (view.innerWidth && view.innerHeight) lines.push(`Viewport: ${view.innerWidth}x${view.innerHeight}`);
  lines.push("Presses, oldest first (event@ms after the page heard the press; a value in brackets is the input's own age):");
  lines.push(sendPressTrace() || "(none recorded)");
  return lines.join("\n");
}

/** Chromium can tell whether a discrete input (a lift) waits in the queue. */
function inputPending(): boolean {
  const scheduling = (globalThis.navigator as { scheduling?: { isInputPending?: () => boolean } } | undefined)?.scheduling;
  try {
    return scheduling?.isInputPending?.() === true;
  } catch {
    return false;
  }
}

function describe(target: EventTarget | null): string {
  const element = target as { tagName?: string; classList?: { item(index: number): string | null } } | null;
  const tag = element?.tagName?.toLowerCase() ?? "?";
  const name = element?.classList?.item(0);
  return name ? `${tag}.${name}` : tag;
}

/** Makes `control` a Send: listens for presses on it until the returned
 *  function is called. The control needs no event handlers of its own. */
export function attachSendPress(control: HTMLElement, handlers: SendPressHandlers, { now = () => performance.now() }: SendPressOptions = {}): () => void {
  const doc = control.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win) return () => {};

  let press: Press | null = null;
  let fadeTimer: number | null = null;
  let listening = false;
  let disposed = false;

  const inside = (target: EventTarget | null): boolean => {
    if (!target) return false;
    try {
      return target === control || control.contains(target as Node);
    } catch {
      return false;
    }
  };
  const disabled = (): boolean => (control as HTMLButtonElement).disabled === true
    || control.getAttribute?.("aria-disabled") === "true";

  // ── The ring ────────────────────────────────────────────────────────────
  const clearRing = () => {
    if (fadeTimer !== null) win.clearTimeout(fadeTimer);
    fadeTimer = null;
    delete control.dataset.sendHold;
    control.style.removeProperty("--send-hold-age");
  };
  const armRing = (ageMs: number, holdMs: number) => {
    // A ring still fading from the last press starts over from empty: the
    // animation has to be dropped for one style pass to run again.
    if (control.dataset.sendHold !== undefined) {
      clearRing();
      void control.offsetWidth;
    }
    control.style.setProperty("--send-hold-age", `${-Math.round(Math.min(Math.max(ageMs, 0), holdMs))}ms`);
    control.dataset.sendHold = "arming";
  };
  const releaseRing = () => {
    if (control.dataset.sendHold === undefined) return;
    if (fadeTimer !== null) win.clearTimeout(fadeTimer);
    control.dataset.sendHold = "release";
    fadeTimer = win.setTimeout(() => {
      fadeTimer = null;
      if (press && press.phase !== "spent") return;
      clearRing();
    }, SEND_HOLD_RELEASE_MS);
  };

  // ── The press ───────────────────────────────────────────────────────────
  const note = (current: Press, name: string, stamp?: number) => {
    if (current.trace.events.length >= TRACE_EVENTS) return;
    const at = now();
    const offset = Math.round(at - current.seenAt);
    // The input's own age is shown when it differs from when the page heard it.
    const own = stamp === undefined ? null : Math.round(inputTime(stamp, at) - current.seenAt);
    current.trace.events.push(own !== null && Math.abs(own - offset) > 8 ? `${name}@${offset}(${own})` : `${name}@${offset}`);
  };
  const clearTimer = (current: Press) => {
    if (current.timer !== null) win.clearTimeout(current.timer);
    current.timer = null;
  };
  const stillOnControl = (current: Press, x: number, y: number): boolean => {
    const under = doc.elementFromPoint?.(x, y) ?? null;
    return releaseSends({
      down: { x: current.x, y: current.y },
      up: { x, y },
      rect: control.getBoundingClientRect(),
      overControl: under ? control.contains(under) : null,
    });
  };
  const heldFor = (current: Press, family: "pointer" | "touch", stamp: number): number => {
    const downAt = current.downAt[family] ?? current.downAt.pointer ?? current.downAt.touch ?? current.seenAt;
    return inputTime(stamp, now()) - downAt;
  };

  /** The one place a press takes effect. */
  const settle = (current: Press, outcome: SendPressOutcome, by: string, endHeard: boolean) => {
    if (current.phase === "spent") return;
    const cued = current.phase === "cued";
    clearTimer(current);
    current.phase = "spent";
    current.result = outcome;
    current.endedAt = endHeard ? now() : null;
    current.trace.outcome = `${outcome} (${by})`;
    releaseRing();
    persistTrace();
    if (cued && outcome !== "draft") handlers.onCueDropped?.();
    if (outcome === "send") handlers.onSend();
    else if (outcome === "draft") handlers.onDraft();
  };
  /** A lift: the press sends, keeps its draft, or was abandoned off Send. */
  const release = (current: Press, family: "pointer" | "touch", stamp: number, x: number, y: number, by: string) => {
    note(current, by, stamp);
    if (current.phase === "spent") {
      current.endedAt ??= now();
      persistTrace();
      return;
    }
    if (sendPressOutcome(heldFor(current, family, stamp), current.holdMs) === "draft") settle(current, "draft", by, true);
    else settle(current, stillOnControl(current, x, y) ? "send" : "none", by, true);
  };
  /** The system took the touch away, so no lift will be heard. A hold that
   *  was already reached is kept; any other press stays open and ends like one
   *  whose lift was lost: by its click, or by its hold. */
  const lose = (current: Press, family: "pointer" | "touch", stamp: number, by: string) => {
    note(current, by, stamp);
    if (current.phase === "spent") {
      current.endedAt ??= now();
      persistTrace();
      return;
    }
    if (sendPressOutcome(heldFor(current, family, stamp), current.holdMs) === "draft") settle(current, "draft", by, true);
  };
  /** The press is over without a lift on Send (another press began, the page
   *  was hidden): the check it already showed is honoured, nothing else is. */
  const abandon = (current: Press, by: string) => {
    if (current.phase === "spent") return;
    note(current, by);
    settle(current, current.phase === "cued" ? "draft" : "none", by, false);
  };
  /** Lets a lift that already waits in the queue run before a timer decides. */
  const yieldToInput = (current: Press, then: () => void): boolean => {
    if (current.yields >= 3 || !inputPending()) return false;
    current.yields += 1;
    current.timer = win.setTimeout(then, 0);
    return true;
  };
  const keepHeld = (current: Press) => {
    current.timer = null;
    if (press !== current || current.phase !== "cued") return;
    if (yieldToInput(current, () => keepHeld(current))) return;
    note(current, "grace");
    settle(current, "draft", "held", false);
  };
  const reachHold = (current: Press) => {
    current.timer = null;
    if (press !== current || current.phase !== "down") return;
    if (yieldToInput(current, () => reachHold(current))) return;
    note(current, "hold");
    // A pointer that wandered off Send while it was down is not holding it.
    if (!stillOnControl(current, current.lastX, current.lastY)) {
      settle(current, "none", "left", false);
      return;
    }
    current.phase = "cued";
    current.yields = 0;
    control.dataset.sendHold = "full";
    handlers.onCue?.();
    current.timer = win.setTimeout(() => keepHeld(current), SEND_HOLD_GRACE_MS);
  };

  const begin = (kind: string, pointerId: number | null, touchId: number | null, stamp: number, x: number, y: number): Press => {
    const at = now();
    const downAt = inputTime(stamp, at);
    const holdMs = Math.max(0, handlers.holdMs());
    const current: Press = {
      pointerId,
      touchId,
      downAt: { pointer: pointerId !== null ? downAt : null, touch: touchId !== null ? downAt : null },
      seenAt: at,
      x, y, lastX: x, lastY: y,
      holdMs,
      phase: "down",
      result: "none",
      endedAt: null,
      timer: null,
      yields: 0,
      trace: {
        at: Date.now(),
        kind,
        hold: holdMs,
        focus: describe(doc.activeElement),
        events: [],
        outcome: "open",
      },
    };
    remember(current.trace);
    press = current;
    listen();
    if (holdMs > 0) {
      const age = at - downAt;
      armRing(age, holdMs);
      current.timer = win.setTimeout(() => reachHold(current), Math.max(0, holdMs - age));
    }
    return current;
  };

  // ── Events ──────────────────────────────────────────────────────────────
  const onPointerDown = (event: PointerEvent) => {
    const current = press;
    // A press anywhere ends the one before it: its own end never came.
    if (current && current.phase !== "spent" && event.pointerId !== current.pointerId) abandon(current, "superseded");
    // A spent press whose click never came is forgotten with the next press.
    if (press && press.phase === "spent") {
      press = null;
      unlisten();
    }
    if (!inside(event.target)) {
      traceNearMiss("pointerdown", event.target, event.clientX, event.clientY);
      return;
    }
    if (press) return;
    if ((event.pointerType === "mouse" && event.button !== 0) || disabled()) return;
    note(begin(event.pointerType || "pointer", event.pointerId, null, event.timeStamp, event.clientX, event.clientY), "pointerdown", event.timeStamp);
  };
  const onTouchStart = (event: TouchEvent) => {
    const touch = Array.from(event.changedTouches).find((item) => inside(item.target));
    if (!touch) return;
    const current = press;
    if (current && current.phase !== "spent") {
      // The same finger, heard a second time through the touch family.
      if (current.touchId === null) {
        current.touchId = touch.identifier;
        current.downAt.touch = inputTime(event.timeStamp, now());
        note(current, "touchstart", event.timeStamp);
      }
      return;
    }
    if (disabled()) return;
    note(begin("touch", null, touch.identifier, event.timeStamp, touch.clientX, touch.clientY), "touchstart", event.timeStamp);
  };
  const onPointerMove = (event: PointerEvent) => {
    const current = press;
    if (!current || current.phase === "spent" || event.pointerId !== current.pointerId) return;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
  };
  const ownsPointer = (current: Press, event: PointerEvent): boolean => current.pointerId !== null
    ? event.pointerId === current.pointerId
    : inside(event.target);
  const onPointerUp = (event: PointerEvent) => {
    const current = press;
    if (current && ownsPointer(current, event)) release(current, "pointer", event.timeStamp, event.clientX, event.clientY, "pointerup");
  };
  const onPointerCancel = (event: PointerEvent) => {
    const current = press;
    if (current && ownsPointer(current, event)) lose(current, "pointer", event.timeStamp, "pointercancel");
  };
  const ownTouch = (current: Press, event: TouchEvent): Touch | undefined => Array.from(event.changedTouches)
    .find((item) => current.touchId !== null ? item.identifier === current.touchId : inside(item.target));
  const onTouchEnd = (event: TouchEvent) => {
    const current = press;
    const touch = current ? ownTouch(current, event) : undefined;
    if (current && touch) release(current, "touch", event.timeStamp, touch.clientX, touch.clientY, "touchend");
  };
  const onTouchCancel = (event: TouchEvent) => {
    const current = press;
    if (current && ownTouch(current, event)) lose(current, "touch", event.timeStamp, "touchcancel");
  };
  const onHidden = () => {
    const current = press;
    if (doc.visibilityState === "hidden" && current) abandon(current, "hidden");
  };
  const onClick = (event: MouseEvent) => {
    const current = press;
    // Keyboard and assistive activation: a click with no pointer behind it.
    if (event.detail === 0) {
      if (inside(event.target) && !disabled()) {
        remember({ at: Date.now(), kind: "key", hold: 0, focus: "", events: ["click@0"], outcome: "send (click)" });
        handlers.onSend();
      }
      return;
    }
    if (current && current.phase !== "spent") {
      if (!inside(event.target)) return;
      // The tap's click arrived before any other end did: it is the release.
      const placed = event.clientX !== 0 || event.clientY !== 0;
      release(current, "pointer", event.timeStamp, placed ? event.clientX : current.x, placed ? event.clientY : current.y, "click");
      return;
    }
    if (current && current.result !== "none") {
      // The click of a press that already took effect. It must not act again,
      // here or on whatever the control has meanwhile become.
      const fresh = current.endedAt === null || now() - current.endedAt <= SEND_TRAILING_CLICK_MS;
      if (fresh && (inside(event.target) || landedWhereItBegan(current, event))) {
        note(current, "click", event.timeStamp);
        persistTrace();
        press = null;
        unlisten();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    if (!inside(event.target) || disabled()) return;
    // No press behind this click, or one that did nothing: the platform says
    // Send was tapped, and that is enough.
    press = null;
    unlisten();
    remember({ at: Date.now(), kind: "tap", hold: 0, focus: describe(doc.activeElement), events: ["click@0"], outcome: "send (click only)" });
    persistTrace();
    handlers.onSend();
  };
  const landedWhereItBegan = (current: Press, event: MouseEvent): boolean =>
    Math.hypot(event.clientX - current.lastX, event.clientY - current.lastY) <= NEAR_MISS_PX;

  const traceNearMiss = (name: string, target: EventTarget | null, x: number, y: number) => {
    if (disabled()) return;
    const rect = control.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const dx = x < rect.left ? x - rect.left : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? y - rect.top : y > rect.bottom ? y - rect.bottom : 0;
    if (Math.hypot(dx, dy) > NEAR_MISS_PX) return;
    remember({
      at: Date.now(), kind: "near", hold: 0, focus: describe(doc.activeElement),
      events: [`${name}@0`], outcome: `on ${describe(target)} ${Math.round(dx)},${Math.round(dy)}`,
    });
    persistTrace();
  };

  // Presses begin on these; the rest are heard only while one is open.
  const capture = { capture: true, passive: true } as const;
  const ends: Array<[string, (event: never) => void]> = [
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerCancel],
    ["touchend", onTouchEnd],
    ["touchcancel", onTouchCancel],
  ];
  function listen(): void {
    if (listening || disposed) return;
    listening = true;
    for (const [type, handler] of ends) win!.addEventListener(type, handler as EventListener, capture);
    doc.addEventListener("visibilitychange", onHidden);
  }
  function unlisten(): void {
    if (!listening) return;
    listening = false;
    for (const [type, handler] of ends) win!.removeEventListener(type, handler as EventListener, capture);
    doc.removeEventListener("visibilitychange", onHidden);
  }
  win.addEventListener("pointerdown", onPointerDown as EventListener, capture);
  win.addEventListener("touchstart", onTouchStart as EventListener, capture);
  // Not passive: the click of a spent press is cancelled.
  const clicks = { capture: true } as const;
  win.addEventListener("click", onClick as EventListener, clicks);

  return () => {
    disposed = true;
    const current = press;
    if (current) clearTimer(current);
    clearRing();
    unlisten();
    win.removeEventListener("pointerdown", onPointerDown as EventListener, capture);
    win.removeEventListener("touchstart", onTouchStart as EventListener, capture);
    win.removeEventListener("click", onClick as EventListener, clicks);
    press = null;
    // The control is going away, or has become another control, under a press
    // that already took effect: its click is still on the way, and it must not
    // land on whatever stands there now.
    if (!current || current.phase !== "spent" || current.result === "none") return;
    const swallow = (event: MouseEvent) => {
      if (event.detail === 0) return;
      const fresh = current.endedAt === null || now() - current.endedAt <= SEND_TRAILING_CLICK_MS;
      if (!fresh || !(inside(event.target) || landedWhereItBegan(current, event))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
    };
    const hearEnd = () => { current.endedAt ??= now(); };
    const timer = win.setTimeout(() => stop(), SEND_HOLD_GRACE_MS + SEND_TRAILING_CLICK_MS * 4);
    const stop = () => {
      win.clearTimeout(timer);
      win.removeEventListener("click", swallow as EventListener, clicks);
      win.removeEventListener("pointerdown", stop, capture);
      win.removeEventListener("pointerup", hearEnd, capture);
      win.removeEventListener("touchend", hearEnd, capture);
    };
    win.addEventListener("click", swallow as EventListener, clicks);
    win.addEventListener("pointerdown", stop, capture);
    win.addEventListener("pointerup", hearEnd, capture);
    win.addEventListener("touchend", hearEnd, capture);
  };
}
