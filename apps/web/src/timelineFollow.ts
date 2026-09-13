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
  /** Scroll position that puts the new user prompt at its reading anchor. */
  desiredScrollTop: number;
}

/** Extra tail space that holds a new prompt at its contextual reading anchor
 * while the response is short. As response/activity content grows, the space
 * shrinks by the same amount; once exhausted, ordinary tail follow takes over. */
export function requiredTurnSheetPadding(input: TurnSheetPaddingInput): number {
  const baseScrollHeight = Math.max(0, input.scrollHeight - Math.max(0, input.currentPadding));
  return Math.max(0, Math.ceil(input.desiredScrollTop + input.clientHeight - baseScrollHeight));
}

export interface FreshTurnContextInput {
  viewportHeight: number;
  promptHeight: number;
  responseHeight: number;
  /** Everything between the previous answer bubble and the new prompt: its
   *  footer/actions plus the timeline gap. */
  responseToPromptGap: number;
  responseLineHeight: number;
}

/** Vertical room kept above a newly sent prompt so the tail of the previous
 * agent answer remains visible. The peek is based on real response typography
 * and viewport geometry: normally two to four lines, but it yields on short
 * screens so the prompt and useful runway for the next answer are preserved. */
export function freshTurnContextOffset(input: FreshTurnContextInput): number {
  const viewportHeight = Number.isFinite(input.viewportHeight) ? Math.max(0, input.viewportHeight) : 0;
  const promptHeight = Number.isFinite(input.promptHeight) ? Math.max(0, input.promptHeight) : 0;
  const responseHeight = Number.isFinite(input.responseHeight) ? Math.max(0, input.responseHeight) : 0;
  const gap = Number.isFinite(input.responseToPromptGap) ? Math.max(0, input.responseToPromptGap) : 0;
  const lineHeight = Number.isFinite(input.responseLineHeight) ? Math.max(1, input.responseLineHeight) : 1;
  if (viewportHeight === 0 || responseHeight === 0) return 0;

  const proportionalPeek = viewportHeight * 0.12;
  const responsePeek = Math.min(
    responseHeight,
    Math.max(lineHeight * 2, Math.min(lineHeight * 4, proportionalPeek)),
  );
  const nextAnswerRunway = Math.max(lineHeight * 3, viewportHeight * 0.24);
  const maxOffset = Math.max(0, viewportHeight - Math.min(promptHeight, viewportHeight) - nextAnswerRunway);
  return Math.min(gap + responsePeek, maxOffset);
}

/** Live action flight is painted in a clipped viewport overlay. Those nodes
 *  must not drive tail-follow or turn-sheet compensation. */
export function isLiveTimelineOverlay(node: Node): boolean {
  let current: Node | null = node.nodeType === 1 ? node : node.parentNode;
  while (current) {
    if (current.nodeType === 1) {
      const className = (current as { className?: unknown }).className;
      if (typeof className === "string"
        && /(?:^|\s)(activity-live|activity-live-stage|activity-live-layer)(?:\s|$)/.test(className)) {
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

/** True when a timeline mutation is in-flow content that follow/sheet may
 *  chase. Additions, folds and transforms of the live overlay are ignored. */
export function timelineMutationAffectsFollow(records: Iterable<{
  addedNodes: ArrayLike<Node>;
  removedNodes: ArrayLike<Node>;
  target: Node;
}>): boolean {
  for (const record of records) {
    if (record.addedNodes.length > 0 || record.removedNodes.length > 0) {
      const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (nodes.some((node) => !isLiveTimelineOverlay(node))) return true;
      continue;
    }
    if (!isLiveTimelineOverlay(record.target)) return true;
  }
  return false;
}
