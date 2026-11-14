// Pressing and holding Send keeps the message as a draft instead of sending
// it. Both halves of that gesture are the person's: whether it exists at all,
// and how long it takes. A hold that is too short makes an ordinary press land
// as a draft by accident; one that is too long reads as a Send that stopped
// working. `SEND_HOLD_OFF` is the off switch the composer reads as "always send
// at once", so the duration survives being turned off and on again.
// Every press ends in exactly one of the two: shorter than the hold sends,
// the hold or longer keeps a draft (`sendPressOutcome`). Only a press the
// person abandons — a finger slid off Send — does neither.

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
 *  the length or longer, it keeps a draft — even when the timer that saves the
 *  draft has not run yet because the page was busy. */
export function sendPressOutcome(heldMs: number, holdMs: number): "send" | "draft" {
  return holdMs > SEND_HOLD_OFF && heldMs >= holdMs ? "draft" : "send";
}
