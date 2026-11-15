// One press on a Send that can be held to keep the message as a draft
// (sendHold.ts). The press is judged once, when it ends, between the input's
// own two time stamps (`inputTime`): never by a timer, and never by when a
// busy page got round to running the handlers.
//
// Both used to decide. A timer saved the draft while the finger was still
// down, and the release measured `performance.now()` against the press. On a
// page busy for a few hundred milliseconds after the press (the whole composer
// re-rendered for the ring, a turn streamed in), the lift of a quick tap
// waited in the queue: it either measured as a long hold or lost the race to
// the timer, and the tap kept a draft instead of sending or starting the chat.
// The timer now only cues: when the hold length passes with the pointer still
// down, the control shows that letting go keeps the draft (`onFull`).
//
// The ring is the press's own picture, drawn by CSS from one attribute on the
// control, so pressing Send renders nothing in React:
// - `data-send-hold="arming"`: the ring winds round Send over the hold length,
//   started at the press's real age (`--send-hold-age`, a negative animation
//   delay) so that it closes exactly when the hold is reached;
// - `"full"`: the hold length passed with the pointer still down;
// - `"release"`: the ring fades out where it stood, then the attribute goes.

import { inputTime, sendPressOutcome } from "../sendHold.ts";

/** How long a released ring fades before its attribute is dropped: the
 *  slowest theme's `--motion-surface`, plus a frame. */
export const SEND_HOLD_RELEASE_MS = 320;

export type SendHoldPhase = "arming" | "full" | "release";

export interface SendHoldPressOptions {
  /** The hold length passed with the pointer still down: cue that a release
   *  keeps the draft. It decides nothing; the release does. */
  onFull?: () => void;
  /** The clock input stamps are read against (tests). */
  now?: () => number;
}

export interface SendHoldPress {
  /** A hold is armed and not yet ended. */
  readonly armed: boolean;
  /** Arms a hold on `control` for a press that began at `timeStamp` (its
   *  pointerdown's `event.timeStamp`). */
  arm(control: HTMLElement, timeStamp: number, holdMs: number): void;
  /** Ends the armed press, lifted at `timeStamp`: "draft" when it lasted the
   *  hold length, "send" when it did not; null when nothing was armed. */
  release(timeStamp: number): "send" | "draft" | null;
  /** Ends the armed press without a lift on Send (the pointer left it, or the
   *  browser cancelled the press) at `timeStamp`: a press that had already
   *  lasted the hold keeps its draft; any other does nothing. */
  abandon(timeStamp: number): "draft" | null;
  /** Drops the press and its picture at once, unjudged (unmount). */
  dispose(): void;
}

export function createSendHoldPress({ onFull, now = () => performance.now() }: SendHoldPressOptions = {}): SendHoldPress {
  let control: HTMLElement | null = null;
  let downAt = 0;
  let holdMs = 0;
  let armed = false;
  let pendingChecks = 0;
  let fullTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (fullTimer !== null) clearTimeout(fullTimer);
    fullTimer = null;
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    fadeTimer = null;
  };
  const clearPicture = (element: HTMLElement | null) => {
    if (!element) return;
    delete element.dataset.sendHold;
    element.style.removeProperty("--send-hold-age");
  };
  const reachFull = () => {
    fullTimer = null;
    if (!armed) return;
    // A lift already queued behind a busy page has not been dispatched yet.
    // Where the engine can tell, let it run first rather than cue a hold that
    // has in fact ended. The release decides either way.
    if (pendingChecks < 3 && inputPending()) {
      pendingChecks += 1;
      fullTimer = setTimeout(reachFull, 0);
      return;
    }
    if (control) control.dataset.sendHold = "full";
    onFull?.();
  };
  const end = (timeStamp: number): "send" | "draft" => {
    const outcome = sendPressOutcome(inputTime(timeStamp, now()) - downAt, holdMs);
    armed = false;
    clearTimers();
    const element = control;
    if (element) {
      element.dataset.sendHold = "release";
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        if (control !== element || armed) return;
        clearPicture(element);
        control = null;
      }, SEND_HOLD_RELEASE_MS);
    }
    return outcome;
  };

  return {
    get armed() { return armed; },
    arm(element, timeStamp, length) {
      clearTimers();
      if (control && control !== element) clearPicture(control);
      const at = now();
      downAt = inputTime(timeStamp, at);
      holdMs = length;
      armed = true;
      pendingChecks = 0;
      control = element;
      // A ring still fading from the last press starts over from empty: the
      // animation has to be dropped for one style pass to run again.
      if (element.dataset.sendHold !== undefined) {
        clearPicture(element);
        void element.offsetWidth;
      }
      const age = Math.min(Math.max(at - downAt, 0), length);
      element.style.setProperty("--send-hold-age", `${-Math.round(age)}ms`);
      element.dataset.sendHold = "arming";
      fullTimer = setTimeout(reachFull, Math.max(0, length - age));
    },
    release(timeStamp) {
      return armed ? end(timeStamp) : null;
    },
    abandon(timeStamp) {
      if (!armed) return null;
      return end(timeStamp) === "draft" ? "draft" : null;
    },
    dispose() {
      armed = false;
      clearTimers();
      clearPicture(control);
      control = null;
    },
  };
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
