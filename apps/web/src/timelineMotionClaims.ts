/**
 * Elements whose motion is already owned: a row chatMotion animated, or one a
 * rewind choreography (rewindMotion.ts) is moving. The arrival observer never
 * layers a second entrance over a claimed element.
 *
 * Deliberately side-effect free, unlike chatMotion.ts (which installs global
 * watchers on import), so the Timeline can claim rows without pulling those
 * watchers into its own import graph.
 */
export const timelineMotionClaims = new WeakSet<HTMLElement>();

export function claimTimelineMotion(element: HTMLElement): void {
  timelineMotionClaims.add(element);
}

/** WAAPI id of chatMotion's row entrance. A tail lift that moves the same row
 *  takes over its transform and leaves the entrance an opacity-only fade. */
export const TIMELINE_ENTRANCE_ANIMATION_ID = "chat-entrance";

/** WAAPI id of the composer→prompt send flight: the only motion the fresh-turn
 *  settle waits for (a tail lift or an entrance on the prompt must not). */
export const TIMELINE_SEND_FLIGHT_ANIMATION_ID = "chat-send-flight";

/** Send flights in the air. The timeline asks this on every model update;
 *  `Element.getAnimations()` would flush style for the whole document each
 *  time (the costliest call of a live turn on a phone). chatMotion adds a
 *  flight when it starts and removes it when it ends, however it ends. */
export const sendFlightsInAir = new Set<Animation>();
