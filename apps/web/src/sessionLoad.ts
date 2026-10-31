// Opening an existing chat: one calm reveal, and no placeholder
// flash while the canonical window is on its way. Pure presentation timings and
// one small state machine — the session surface owns the clock and the timers,
// so this module stays DOM-free and directly testable.
//
// Contract: nothing for the first beat on a fast open — the surface on screen
// (the previous session, or the fresh hero) keeps the area; a slower open then
// shows the placeholder, so a switch never looks like it bounced back; once
// shown, the placeholder cross-fades out under the revealed transcript.

/** Nothing appears for this long: a fast open must not flash a skeleton. */
export const SESSION_PLACEHOLDER_DELAY_MS = 250;
/** The placeholder's fade-out beat, under the revealed transcript. */
export const SESSION_PLACEHOLDER_FADE_MS = 200;
/** Reveal of a cold open: the placeholder was already on screen. */
export const SESSION_REVEAL_MS = 260;
/** Reveal of a cached/fast switch: shorter, because nothing was waiting. */
export const SESSION_REVEAL_CACHED_MS = 160;
/** First-send handoff: how long the hero holds while its body fades before the
 *  transcript replaces the fresh-session surface. */
export const SESSION_FIRST_SEND_HOLD_MS = 260;

export interface SessionLoadState {
  /** When the current loading episode began, or null when nothing is loading. */
  since: number | null;
  /** The placeholder should be on screen right now. */
  shown: boolean;
  /** The placeholder was shown in the current episode (picks the reveal beat). */
  everShown: boolean;
  /** The content is ready and the placeholder is fading out. */
  leaving: boolean;
  /** Earliest instant the fading placeholder may unmount. */
  leaveUntil: number | null;
  /** Next instant this machine changes on its own, for the caller's timer. */
  nextChangeAt: number | null;
}

export const IDLE_SESSION_LOAD: SessionLoadState = {
  since: null,
  shown: false,
  everShown: false,
  leaving: false,
  leaveUntil: null,
  nextChangeAt: null,
};

export interface SessionLoadInput {
  /** A canonical event load for a not-yet-visible session is in flight. */
  loading: boolean;
  now: number;
}

/** Advance the placeholder machine. Pure: the caller owns the clock and timer. */
export function advanceSessionLoad(
  state: SessionLoadState,
  input: SessionLoadInput,
): SessionLoadState {
  const { loading, now } = input;
  if (!loading) {
    // The episode is over: `since` clears here so the next open measures its own
    // delay, while `everShown` survives into the fade and the reveal beat.
    if (!state.shown && state.leaveUntil === null) {
      return state.since === null && !state.everShown ? state : { ...state, since: null, leaving: false, nextChangeAt: null };
    }
    if (state.leaveUntil === null) {
      const until = now + SESSION_PLACEHOLDER_FADE_MS;
      return { since: null, shown: false, everShown: state.everShown, leaving: true, leaveUntil: until, nextChangeAt: until };
    }
    if (now >= state.leaveUntil) {
      return { since: null, shown: false, everShown: state.everShown, leaving: false, leaveUntil: null, nextChangeAt: null };
    }
    return state;
  }
  const freshEpisode = state.since === null;
  const since = state.since ?? now;
  const shown = freshEpisode ? false : state.shown;
  const everShown = freshEpisode ? false : state.everShown;
  if (shown) return { since, shown, everShown, leaving: false, leaveUntil: null, nextChangeAt: null };
  if (now - since >= SESSION_PLACEHOLDER_DELAY_MS) {
    return { since, shown: true, everShown: true, leaving: false, leaveUntil: null, nextChangeAt: null };
  }
  return { since, shown: false, everShown, leaving: false, leaveUntil: null, nextChangeAt: since + SESSION_PLACEHOLDER_DELAY_MS };
}

/** The reveal beat for a surface that has just landed. */
export function sessionRevealDuration(everShown: boolean): number {
  return everShown ? SESSION_REVEAL_MS : SESSION_REVEAL_CACHED_MS;
}

/** The reveal phase for the commit that lands a session id. A suppressed change
 *  is the first-send handoff: the surface is already on screen and the arriving
 *  transcript owns its own motion, so the reveal must not replay over it. */
export function sessionRevealPhase(
  changed: boolean,
  suppress: boolean,
  statePhase: "entering" | "idle",
): "entering" | "idle" {
  if (!changed) return statePhase;
  return suppress ? "idle" : "entering";
}
