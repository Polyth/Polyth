/** A timeline is attached only at its real tail. The old 80px "near tail"
 * band made a small upward wheel gesture re-enable following immediately. */
export const TIMELINE_TAIL_EPSILON = 2;

export interface TimelineFollowSample {
  scrollTop: number;
  previousScrollTop: number;
  distanceFromEnd: number;
  readerDetached: boolean;
  /** Input captured before the scroll event. Layout reflow has no intent. */
  readerIntent?: "toward-history" | "toward-tail" | null;
}

export interface TimelineFollowState {
  readerDetached: boolean;
  following: boolean;
  showJump: boolean;
}

/** Resolve a timeline scroll without confusing browser layout correction for
 * reader intent. Wheel, touch, keyboard and scrollbar handlers own detach;
 * ResizeObserver, shrinking turn space and composer reflow carry no intent.
 * Once detached, the reader reconnects only while deliberately moving down
 * into the true tail. */
export function timelineFollowState(sample: TimelineFollowSample): TimelineFollowState {
  const movingDown = sample.scrollTop > sample.previousScrollTop + 0.25;
  const atTail = sample.distanceFromEnd <= TIMELINE_TAIL_EPSILON;
  let readerDetached = sample.readerDetached || sample.readerIntent === "toward-history";
  if (readerDetached && sample.readerIntent === "toward-tail" && movingDown && atTail) {
    readerDetached = false;
  }
  return { readerDetached, following: !readerDetached, showJump: readerDetached };
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
