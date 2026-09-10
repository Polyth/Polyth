/** A timeline is attached only at its real tail. The old 80px "near tail"
 * band made a small upward wheel gesture re-enable following immediately. */
export const TIMELINE_TAIL_EPSILON = 2;

export interface TimelineFollowSample {
  scrollTop: number;
  previousScrollTop: number;
  distanceFromEnd: number;
  readerDetached: boolean;
}

export interface TimelineFollowState {
  readerDetached: boolean;
  following: boolean;
  showJump: boolean;
}

/** Resolve a real reader scroll. Moving upward always detaches, even if the
 * movement is sub-pixel and still very close to the tail. A detached reader
 * reconnects only by deliberately reaching the true tail while moving down. */
export function timelineFollowState(sample: TimelineFollowSample): TimelineFollowState {
  const movingUp = sample.scrollTop < sample.previousScrollTop - 0.25;
  const movingDown = sample.scrollTop > sample.previousScrollTop + 0.25;
  const atTail = sample.distanceFromEnd <= TIMELINE_TAIL_EPSILON;
  let readerDetached = sample.readerDetached || movingUp;
  if (readerDetached && movingDown && atTail) readerDetached = false;
  const following = !readerDetached && atTail;
  return { readerDetached, following, showJump: !following };
}

export interface TurnSheetPaddingInput {
  /** Current total scroll height, including currentPadding. */
  scrollHeight: number;
  /** Presentation-only padding currently reserved for the fresh turn. */
  currentPadding: number;
  clientHeight: number;
  /** Scroll position that puts the new user prompt at the reading top. */
  desiredScrollTop: number;
}

/** Extra tail space that makes a new prompt align with the reading top while
 * the response is short. As response/activity content grows, the space
 * shrinks by the same amount; once exhausted, ordinary tail follow takes over. */
export function requiredTurnSheetPadding(input: TurnSheetPaddingInput): number {
  const baseScrollHeight = Math.max(0, input.scrollHeight - Math.max(0, input.currentPadding));
  return Math.max(0, Math.ceil(input.desiredScrollTop + input.clientHeight - baseScrollHeight));
}
