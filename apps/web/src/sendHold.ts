// Pressing and holding Send keeps the message as a draft instead of sending
// it. Both halves of that gesture are the person's: whether it exists at all,
// and how long it takes. A hold that is too short makes an ordinary press land
// as a draft by accident; one that is too long reads as a Send that stopped
// working. `SEND_HOLD_OFF` is the off switch the composer reads as "always send
// at once", so the duration survives being turned off and on again.
// Every press ends in exactly one of the two: shorter than the hold sends,
// the hold or longer keeps a draft (`sendPressOutcome`), measured between the
// input's own time stamps (`inputTime`). Only a press the person abandons — a
// finger slid off Send — does neither. The press itself, its ring and its
// cue live in `composer/sendHoldPress.ts`.

/** Shortest hold that is still visibly deliberate. */
export const SEND_HOLD_MIN_MS = 250;
/** Longest hold worth waiting through before a press is clearly a hold. */
export const SEND_HOLD_MAX_MS = 2000;
/** The slider moves in 50 ms steps; keep the committed value on the same grid. */
export const SEND_HOLD_STEP_MS = 50;
/** The install default, and the length the ring was drawn for before it was a
 *  preference (docs/dev/ui.md, "Drafts"). */
export const SEND_HOLD_DEFAULT_MS = 500;
/** The setting is off: Send always sends at once. */
export const SEND_HOLD_OFF = 0;

/** A stored hold length, snapped to the slider's grid and clamped. A missing,
 *  zero or unreadable value falls back to the default; use `sendHoldMs` to read
 *  the off switch. */
export function parseSendHoldMs(value: unknown): number {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return SEND_HOLD_DEFAULT_MS;
  const stepped = Math.round(ms / SEND_HOLD_STEP_MS) * SEND_HOLD_STEP_MS;
  return Math.min(SEND_HOLD_MAX_MS, Math.max(SEND_HOLD_MIN_MS, stepped));
}

/** The hold the composer arms, or `SEND_HOLD_OFF` when the gesture is off. */
export function sendHoldMs(prefs: { sendHoldDraft: boolean; sendHoldDraftMs: number }): number {
  return prefs.sendHoldDraft ? parseSendHoldMs(prefs.sendHoldDraftMs) : SEND_HOLD_OFF;
}

/** What a press on Send that ended after `heldMs` does: the two outcomes have
 *  no gap between them. Released before the hold length, it sends; held for
 *  the length or longer, it keeps a draft. */
export function sendPressOutcome(heldMs: number, holdMs: number): "send" | "draft" {
  return holdMs > SEND_HOLD_OFF && heldMs >= holdMs ? "draft" : "send";
}

/** When an input happened: its event's own `timeStamp`, on the same clock as
 *  `performance.now()`. A press is measured between the finger's own two
 *  stamps, never by when a busy page got round to running the handlers: a
 *  60 ms tap whose lift waited out a long render measured as a full hold and
 *  kept a draft instead of sending. A stamp that cannot be on that clock (zero,
 *  in the future, or an epoch time from an old engine) falls back to `now`. */
export function inputTime(timeStamp: number | undefined, now: number): number {
  if (timeStamp === undefined || !Number.isFinite(timeStamp) || timeStamp <= 0) return now;
  if (timeStamp > now + 1 || now - timeStamp > 60_000) return now;
  return timeStamp;
}
